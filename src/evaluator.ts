import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  ModelRegistry,
  softmax,
  type DataType,
  type DeviceType,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor,
} from "@huggingface/transformers"
import {
  DEFAULT_MODEL_ESTIMATED_BYTES,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REVISION,
  DEFAULT_NLI_BATCH_SIZE,
  LEGACY_EMBEDDING_CACHE,
  LEGACY_NLI_CACHE,
  MAX_NLI_PAIRS,
  MAX_NLI_SEQUENCE_LENGTH,
  NLI_TASK,
} from "./model-config.ts"
import {
  aggregateCriteria,
  classifyCriterion,
  evaluationAnswerContexts,
  normalizeRequest,
} from "./scoring.ts"
import { ResilientFetchSession } from "./resilient-fetch.ts"
import type {
  CriterionResult,
  EvaluationDiagnostic,
  EvaluationRequest,
  EvaluationResult,
  ModelCacheInfo,
  ModelLoadSource,
  ModelProgress,
  NliEvidence,
  RuntimeConfig,
  RuntimeStatus,
} from "./types.ts"

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  assessmentEngine: "compact",
  modelId: DEFAULT_MODEL_ID,
  revision: DEFAULT_MODEL_REVISION,
  device: "wasm",
  dtype: "q8",
  fallbackToWasm: true,
  batchSize: DEFAULT_NLI_BATCH_SIZE,
}

interface TokenizedInputs {
  input_ids: Tensor
  attention_mask: Tensor
  token_type_ids?: Tensor
  [name: string]: Tensor | undefined
}

interface SequenceClassifierOutput {
  logits: Tensor
}

type NliModel = PreTrainedModel &
  ((inputs: TokenizedInputs) => Promise<SequenceClassifierOutput>)

interface NliLabelIds {
  entailment: number
  neutral: number
  contradiction: number
}

interface NliRuntime {
  tokenizer: PreTrainedTokenizer
  model: NliModel
  labels: NliLabelIds
}

interface NliPair {
  premise: string
  hypothesis: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  )
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now()
}

function emit<T>(name: string, detail: T): void {
  if (typeof globalThis.dispatchEvent !== "function" || typeof CustomEvent === "undefined") return
  globalThis.dispatchEvent(new CustomEvent(name, { detail }))
}

const runtimeAssetBaseUrl = (() => {
  if (typeof document === "undefined") return undefined
  const currentSource = (document.currentScript as HTMLScriptElement | null)?.src
  if (currentSource) return new URL(".", currentSource).href

  const scripts = Array.from(document.scripts)
  for (let index = scripts.length - 1; index >= 0; index -= 1) {
    const source = scripts[index]?.src
    if (source && /(?:^|\/)index(?:\.[\da-f]+)?\.js(?:[?#]|$)/iu.test(source)) {
      return new URL(".", source).href
    }
  }
  return undefined
})()

const ORT_FACTORY_FILENAME = "ort-wasm-simd-threaded.asyncify.mjs"
const ORT_WASM_FILENAME = "ort-wasm-simd-threaded.asyncify.wasm"
let localOnnxRuntimePromise: Promise<void> | null = null

function runtimeAssetUrl(filename: string): string {
  return runtimeAssetBaseUrl
    ? new URL(filename, runtimeAssetBaseUrl).href
    : filename
}

function configureLocalOnnxRuntime(): void {
  if (!env.backends.onnx.wasm) return
  env.backends.onnx.wasm.wasmPaths = {
    mjs: runtimeAssetUrl(ORT_FACTORY_FILENAME),
    wasm: runtimeAssetUrl(ORT_WASM_FILENAME),
  }
}

async function prepareLocalOnnxRuntime(
  session: ResilientFetchSession,
): Promise<void> {
  const wasmOptions = env.backends.onnx.wasm
  if (!wasmOptions || wasmOptions.wasmBinary) return
  if (!localOnnxRuntimePromise) {
    localOnnxRuntimePromise = (async () => {
      const [factoryResponse, wasmResponse] = await Promise.all([
        session.fetch(runtimeAssetUrl(ORT_FACTORY_FILENAME)),
        session.fetch(runtimeAssetUrl(ORT_WASM_FILENAME)),
      ])
      if (!factoryResponse.ok || !wasmResponse.ok) {
        throw new Error(
          `Die lokale ONNX-Laufzeit konnte nicht geladen werden (MJS ${factoryResponse.status}, WASM ${wasmResponse.status}).`,
        )
      }
      const [factoryCode, wasmBinary] = await Promise.all([
        factoryResponse.text(),
        wasmResponse.arrayBuffer(),
      ])
      const factoryBlobUrl = URL.createObjectURL(
        new Blob([factoryCode], { type: "text/javascript" }),
      )
      wasmOptions.wasmBinary = wasmBinary
      wasmOptions.wasmPaths = {
        mjs: factoryBlobUrl,
        wasm: runtimeAssetUrl(ORT_WASM_FILENAME),
      }
    })().catch((error) => {
      localOnnxRuntimePromise = null
      throw error
    })
  }
  await localOnnxRuntimePromise
}

function progressFromUnknown(value: unknown): ModelProgress {
  if (typeof value !== "object" || value === null) return { status: "loading" }
  const item = value as Record<string, unknown>
  return {
    status: typeof item.status === "string" ? item.status : "loading",
    progress: typeof item.progress === "number" ? item.progress : undefined,
    loaded: typeof item.loaded === "number" ? item.loaded : undefined,
    total: typeof item.total === "number" ? item.total : undefined,
    file: typeof item.file === "string" ? item.file : undefined,
    message: typeof item.message === "string" ? item.message : undefined,
  }
}

function compactDiagnostic(
  status: EvaluationResult["status"],
  passed: boolean,
  criteria: readonly CriterionResult[],
): EvaluationDiagnostic | undefined {
  if (passed) return undefined
  if (criteria.some((criterion) => criterion.status === "contradicted")) {
    return {
      code: "content-error",
      source: "compact",
      severity: "blocking",
    }
  }
  return {
    code: status === "uncertain" ? "unclear" : "incomplete",
    source: "compact",
    severity: "blocking",
  }
}

function labelKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_")
}

function numericLabel(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number.parseInt(value, 10)
  return null
}

function resolveNliLabels(config: unknown): NliLabelIds {
  if (typeof config !== "object" || config === null) {
    throw new Error("Die NLI-Modellkonfiguration fehlt.")
  }

  const record = config as {
    label2id?: Record<string, unknown>
    id2label?: Record<string, unknown>
  }
  const resolved = new Map<string, number>()

  for (const [label, rawId] of Object.entries(record.label2id ?? {})) {
    const id = numericLabel(rawId)
    if (id !== null) resolved.set(labelKey(label), id)
  }
  for (const [rawId, rawLabel] of Object.entries(record.id2label ?? {})) {
    if (typeof rawLabel !== "string") continue
    const id = numericLabel(rawId)
    if (id !== null && !resolved.has(labelKey(rawLabel))) {
      resolved.set(labelKey(rawLabel), id)
    }
  }

  const entailment = resolved.get("entailment")
  const neutral = resolved.get("neutral")
  const contradiction = resolved.get("contradiction")
  if (
    entailment === undefined ||
    neutral === undefined ||
    contradiction === undefined ||
    new Set([entailment, neutral, contradiction]).size !== 3
  ) {
    throw new Error(
      "Das gewählte Modell benötigt eindeutige Labels für entailment, neutral und contradiction.",
    )
  }

  return { entailment, neutral, contradiction }
}

function toLogitRows(tensor: Tensor, expectedRows: number): number[][] {
  const raw = tensor.tolist()
  const rows =
    expectedRows === 1 &&
    Array.isArray(raw) &&
    raw.length > 0 &&
    typeof raw[0] === "number"
      ? [raw]
      : raw

  if (!Array.isArray(rows) || rows.length !== expectedRows) {
    const count = Array.isArray(rows) ? rows.length : 0
    throw new Error(
      `Unerwartete NLI-Ausgabe: ${count} statt ${expectedRows} Zeilen.`,
    )
  }

  return rows.map((row, index) => {
    if (!Array.isArray(row) || !row.every((value) => typeof value === "number")) {
      throw new Error(`NLI-Ausgabe ${index + 1} hat ein unerwartetes Format.`)
    }
    return row
  })
}

function disposeInputs(inputs: TokenizedInputs): void {
  const seen = new Set<Tensor>()
  for (const value of Object.values(inputs)) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    value.dispose()
  }
}

function uniqueTexts(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function bestBy(
  values: readonly NliEvidence[],
  score: (value: NliEvidence) => number,
): NliEvidence {
  const first = values[0]
  if (!first) throw new Error("Mindestens ein NLI-Ergebnis wird benötigt.")

  let best = first
  let bestScore = score(first)
  for (let index = 1; index < values.length; index += 1) {
    const candidate = values[index]!
    const candidateScore = score(candidate)
    if (candidateScore > bestScore) {
      best = candidate
      bestScore = candidateScore
    }
  }
  return best
}

function hubUrl(modelId: string, revision: string, file: string): string {
  let path = env.remotePathTemplate
    .replaceAll("{model}", modelId)
    .replaceAll("{revision}", encodeURIComponent(revision))
  if (!path.endsWith("/")) path += "/"
  return new URL(`${path}${file}`, env.remoteHost).href
}

async function aliasPinnedTokenizerMetadata(
  modelId: string,
  revision: string,
): Promise<void> {
  if (
    revision === "main" ||
    typeof caches === "undefined" ||
    !env.useBrowserCache
  ) {
    return
  }

  try {
    const cache = await caches.open(env.cacheKey)
    const pinnedUrl = hubUrl(modelId, revision, "tokenizer_config.json")
    const mainUrl = hubUrl(modelId, "main", "tokenizer_config.json")
    const pinned = await cache.match(pinnedUrl)
    if (pinned && !(await cache.match(mainUrl))) {
      await cache.put(mainUrl, pinned.clone())
    }
  } catch {
    // Best effort: online loading still works without this metadata alias.
  }
}

async function deleteTokenizerMetadataAlias(
  modelId: string,
  revision: string,
): Promise<number> {
  if (
    revision === "main" ||
    typeof caches === "undefined" ||
    !env.useBrowserCache
  ) {
    return 0
  }

  try {
    const cache = await caches.open(env.cacheKey)
    return (await cache.delete(hubUrl(modelId, "main", "tokenizer_config.json")))
      ? 1
      : 0
  } catch {
    return 0
  }
}

export class SemanticEvaluator {
  private config: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG }
  private phase: RuntimeStatus["phase"] = "idle"
  private loadSource: ModelLoadSource | undefined
  private lastError: string | undefined
  private runtime: NliRuntime | null = null
  private loadPromise: Promise<NliRuntime> | null = null
  private fetchSession: ResilientFetchSession | null = null
  private inferenceQueue: Promise<void> = Promise.resolve()

  constructor() {
    env.allowLocalModels = false
    env.allowRemoteModels = true
    env.useBrowserCache = true
    // ORT is shipped with this exact bundle. Avoid the fragile CDN
    // fetch -> response.clone() -> Cache.put() preload seen in Edge.
    configureLocalOnnxRuntime()
    env.useWasmCache = false
  }

  configure(next: Partial<RuntimeConfig>): RuntimeStatus {
    const supported = { ...next }
    delete supported.assessmentEngine
    delete supported.maxCachedEmbeddings

    const changesLoadedModel = (
      ["modelId", "revision", "device", "dtype", "fallbackToWasm"] as const
    ).some(
      (key) =>
        supported[key] !== undefined && supported[key] !== this.config[key],
    )
    if (
      (this.phase === "loading" || this.phase === "ready") &&
      changesLoadedModel
    ) {
      throw new Error(
        "Die Modellkonfiguration kann nach dem Laden nicht mehr geändert werden.",
      )
    }

    const merged = { ...this.config, ...supported }
    if (!merged.modelId.trim()) throw new Error("modelId darf nicht leer sein.")
    if (!merged.revision.trim()) throw new Error("revision darf nicht leer sein.")
    if (
      !Number.isInteger(merged.batchSize) ||
      merged.batchSize < 1 ||
      merged.batchSize > 16
    ) {
      throw new Error("batchSize muss eine ganze Zahl zwischen 1 und 16 sein.")
    }

    this.config = merged
    this.lastError = undefined
    return this.getStatus()
  }

  getStatus(): RuntimeStatus {
    return {
      phase: this.phase,
      loadSource: this.loadSource,
      assessmentEngine: "compact",
      modelId: this.config.modelId,
      revision: this.config.revision,
      device: this.config.device,
      dtype: this.config.dtype,
      error: this.lastError,
    }
  }

  private setPhase(phase: RuntimeStatus["phase"], error?: string): void {
    this.phase = phase
    this.lastError = error
    emit("lia-llm:status", this.getStatus())
  }

  private async createRuntime(): Promise<NliRuntime> {
    if (typeof globalThis.fetch !== "function") {
      throw new Error("Dieser Browser stellt keine Download-Schnittstelle bereit.")
    }
    const previousFetch = env.fetch
    const session = new ResilientFetchSession(globalThis.fetch.bind(globalThis), {
      onRetry: ({ attempt }) => {
        emit<ModelProgress>("lia-llm:progress", {
          status: "retry",
          message: `Netzwerkunterbrechung – Teil-Download wird erneut versucht (${attempt}/4).`,
        })
      },
    })
    this.fetchSession = session
    env.fetch = session.fetch
    try {
      await prepareLocalOnnxRuntime(session)
      return await this.loadRuntime()
    } finally {
      if (this.fetchSession === session) this.fetchSession = null
      if (env.fetch === session.fetch) env.fetch = previousFetch
    }
  }

  private async loadRuntime(): Promise<NliRuntime> {
    let device = this.config.device
    let dtype = this.config.dtype
    const hasWebGpu =
      typeof navigator !== "undefined" &&
      "gpu" in (navigator as Navigator & { gpu?: unknown })

    if (device === "webgpu" && !hasWebGpu) {
      if (!this.config.fallbackToWasm) {
        throw new Error("WebGPU wird von diesem Browser nicht unterstützt.")
      }
      device = "wasm"
      dtype = "q8"
    }

    const onProgress = (value: unknown): void => {
      emit("lia-llm:progress", progressFromUnknown(value))
    }
    const tokenizer = await AutoTokenizer.from_pretrained(this.config.modelId, {
      revision: this.config.revision,
      progress_callback: onProgress,
    })
    await aliasPinnedTokenizerMetadata(this.config.modelId, this.config.revision)

    const loadModel = async (
      selectedDevice: typeof device,
      selectedDtype: typeof dtype,
    ): Promise<NliModel> =>
      AutoModelForSequenceClassification.from_pretrained(this.config.modelId, {
        revision: this.config.revision,
        device: selectedDevice as DeviceType,
        dtype: selectedDtype as DataType,
        progress_callback: onProgress,
      }) as Promise<NliModel>

    let model: NliModel
    try {
      model = await loadModel(device, dtype)
    } catch (error) {
      if (device !== "webgpu" || !this.config.fallbackToWasm) throw error
      emit<ModelProgress>("lia-llm:progress", {
        status: "fallback",
        message: "WebGPU konnte nicht initialisiert werden; Wechsel zu WASM/q8.",
      })
      device = "wasm"
      dtype = "q8"
      model = await loadModel(device, dtype)
    }

    try {
      const labels = resolveNliLabels(model.config)
      this.config = { ...this.config, device, dtype }
      return { tokenizer, model, labels }
    } catch (error) {
      await model.dispose()
      throw error
    }
  }

  async preload(cacheInfo?: ModelCacheInfo): Promise<RuntimeStatus> {
    if (this.runtime) return this.getStatus()
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const cache = cacheInfo ?? (await this.getCacheInfo())
        this.loadSource = cache.cached ? "cache" : "network"
        this.setPhase("loading")
        try {
          return await this.createRuntime()
        } catch (error) {
          if (
            !cache.cached ||
            isAbortError(error) ||
            !env.backends.onnx.wasm?.wasmBinary
          ) {
            throw error
          }
          emit<ModelProgress>("lia-llm:progress", {
            status: "retry",
            message:
              "Der vorhandene Modellcache ist nicht lesbar und wird einmal neu aufgebaut.",
          })
          await ModelRegistry.clear_pipeline_cache(
            NLI_TASK,
            this.config.modelId,
            this.registryOptions(),
          )
          await deleteTokenizerMetadataAlias(
            this.config.modelId,
            this.config.revision,
          )
          this.loadSource = "network"
          return this.createRuntime()
        }
      })()
        .then((runtime) => {
          this.runtime = runtime
          this.setPhase("ready")
          return runtime
        })
        .catch((error: unknown) => {
          const message = errorMessage(error)
          this.loadPromise = null
          this.setPhase("error", message)
          throw error
        })
    }

    await this.loadPromise
    return this.getStatus()
  }

  private async classifyPairs(pairs: readonly NliPair[]): Promise<NliEvidence[]> {
    if (pairs.length === 0) return []
    await this.preload()
    const runtime = this.runtime
    if (!runtime) throw new Error("Das NLI-Modell ist nicht verfügbar.")

    const results: NliEvidence[] = []
    for (let offset = 0; offset < pairs.length; offset += this.config.batchSize) {
      const batch = pairs.slice(offset, offset + this.config.batchSize)
      const premises = batch.map((pair) => pair.premise)
      const hypotheses = batch.map((pair) => pair.hypothesis)
      const inputs = runtime.tokenizer(premises, {
        text_pair: hypotheses,
        padding: true,
        truncation: false,
      }) as TokenizedInputs
      const inputDimensions = inputs.input_ids.dims
      const sequenceLength = inputDimensions[inputDimensions.length - 1] ?? 0
      if (sequenceLength > MAX_NLI_SEQUENCE_LENGTH) {
        disposeInputs(inputs)
        throw new Error(
          `Ein vollständiges Antwort-Musterlösungs-Paar umfasst ${sequenceLength} Tokens; unterstützt werden höchstens ${MAX_NLI_SEQUENCE_LENGTH}. Bitte Antwort oder Musterlösung kürzen.`,
        )
      }

      let output: SequenceClassifierOutput | null = null
      try {
        const currentOutput = await runtime.model(inputs)
        output = currentOutput
        const rows = toLogitRows(currentOutput.logits, batch.length)
        rows.forEach((row, index) => {
          const probabilities = Array.from(softmax(row))
          if (probabilities.length !== 3) {
            throw new Error(
              `Drei NLI-Klassen erwartet, ${probabilities.length} erhalten.`,
            )
          }
          const pair = batch[index]!
          results.push({
            text: pair.premise,
            hypothesis: pair.hypothesis,
            entailment: probabilities[runtime.labels.entailment]!,
            neutral: probabilities[runtime.labels.neutral]!,
            contradiction: probabilities[runtime.labels.contradiction]!,
          })
        })
      } finally {
        output?.logits.dispose()
        disposeInputs(inputs)
      }
    }

    return results
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.inferenceQueue.then(task, task)
    this.inferenceQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    const normalized = normalizeRequest(request)
    return this.enqueue(async () => {
      const started = now()
      const answerContexts = evaluationAnswerContexts(
        normalized.answer,
        normalized.mode,
      )
      if (answerContexts.length === 0) {
        throw new Error("Die Antwort enthält keinen auswertbaren Text.")
      }

      const pairCount = normalized.criteria.reduce((total, criterion) => {
        const positiveCount = uniqueTexts([
          criterion.text,
          ...criterion.acceptedVariants,
        ]).length
        const misconceptionCount = uniqueTexts(criterion.misconceptions).length
        return total + answerContexts.length * (positiveCount + misconceptionCount)
      }, 0)
      if (pairCount > MAX_NLI_PAIRS) {
        throw new Error(
          `Diese Auswertung würde ${pairCount} NLI-Paare erzeugen; erlaubt sind höchstens ${MAX_NLI_PAIRS}. Bitte Antwort, Kriterien oder Varianten auf mehrere Aufgaben verteilen.`,
        )
      }

      const results: CriterionResult[] = []
      for (const criterion of normalized.criteria) {
        const positiveHypotheses = uniqueTexts([
          criterion.text,
          ...criterion.acceptedVariants,
        ])
        const positivePairs = positiveHypotheses.flatMap((hypothesis) =>
          answerContexts.map((premise) => ({ premise, hypothesis })),
        )
        const positiveEvidence = await this.classifyPairs(positivePairs)
        const supportEvidence = bestBy(
          positiveEvidence,
          (evidence) => evidence.entailment,
        )
        const contradictionEvidence = bestBy(
          positiveEvidence,
          (evidence) => evidence.contradiction,
        )

        const misconceptionHypotheses = uniqueTexts(criterion.misconceptions)
        const misconceptionEvidence =
          misconceptionHypotheses.length === 0
            ? undefined
            : bestBy(
                await this.classifyPairs(
                  misconceptionHypotheses.flatMap((hypothesis) =>
                    answerContexts.map((premise) => ({ premise, hypothesis })),
                  ),
                ),
                (evidence) => evidence.entailment,
              )

        results.push(
          classifyCriterion({
            criterion,
            supportEvidence,
            contradictionEvidence,
            misconceptionEvidence,
            uncertaintyMargin: normalized.uncertaintyMargin,
            contrastiveMargin: normalized.contrastiveMargin,
          }),
        )
      }

      const aggregated = aggregateCriteria(results, normalized.passThreshold)
      const diagnostic = compactDiagnostic(
        aggregated.status,
        aggregated.passed,
        results,
      )
      return {
        ...aggregated,
        mode: normalized.mode,
        criteria: results,
        answer: normalized.answer,
        operator: normalized.operator,
        diagnostic,
        durationMs: Number((now() - started).toFixed(1)),
        model: {
          id: this.config.modelId,
          revision: this.config.revision,
          device: this.config.device,
          dtype: this.config.dtype,
          task: "natural-language-inference",
        },
        notice:
          "Lokaler NLI-Selbstcheck: Das Ergebnis unterstützt das Lernen, ersetzt aber keine fachliche Bewertung durch eine Lehrkraft.",
      }
    })
  }

  private registryOptions(): {
    revision: string
    device: DeviceType
    dtype: DataType
  } {
    return {
      revision: this.config.revision,
      device: this.config.device as DeviceType,
      dtype: this.config.dtype as DataType,
    }
  }

  async getCacheInfo(): Promise<ModelCacheInfo> {
    if (typeof caches === "undefined") {
      return {
        supported: false,
        cached: false,
        downloadCached: false,
        filesCached: 0,
        filesTotal: 0,
        estimatedBytes: DEFAULT_MODEL_ESTIMATED_BYTES,
      }
    }

    try {
      const result = await ModelRegistry.is_pipeline_cached_files(
        NLI_TASK,
        this.config.modelId,
        this.registryOptions(),
      )
      const files = result.files ?? []
      return {
        supported: true,
        cached: result.allCached,
        downloadCached: result.allCached,
        filesCached: files.filter((file) => file.cached).length,
        filesTotal: files.length,
        estimatedBytes: DEFAULT_MODEL_ESTIMATED_BYTES,
      }
    } catch (error) {
      return {
        supported: true,
        cached: false,
        downloadCached: false,
        filesCached: 0,
        filesTotal: 0,
        estimatedBytes: DEFAULT_MODEL_ESTIMATED_BYTES,
        error: errorMessage(error),
      }
    }
  }

  async unloadRuntime(): Promise<void> {
    this.fetchSession?.abort()
    return this.enqueue(async () => {
      if (this.loadPromise) {
        try {
          await this.loadPromise
        } catch {
          // A failed load has no usable runtime to release.
        }
      }

      const runtime = this.runtime
      this.runtime = null
      this.loadPromise = null
      if (runtime) await runtime.model.dispose()
      this.loadSource = undefined
      this.setPhase("idle")
    })
  }

  async clearCache(): Promise<number> {
    this.fetchSession?.abort()
    return this.enqueue(async () => {
      if (this.loadPromise) {
        try {
          await this.loadPromise
        } catch {
          // A failed load can still have left partial cache entries.
        }
      }

      const runtime = this.runtime
      this.runtime = null
      this.loadPromise = null
      if (runtime) await runtime.model.dispose()

      let filesDeleted = 0
      const errors: unknown[] = []
      try {
        const result = await ModelRegistry.clear_pipeline_cache(
          NLI_TASK,
          this.config.modelId,
          this.registryOptions(),
        )
        filesDeleted += result.filesDeleted
      } catch (error) {
        errors.push(error)
      }

      try {
        const legacy = await ModelRegistry.clear_pipeline_cache(
          LEGACY_EMBEDDING_CACHE.task,
          LEGACY_EMBEDDING_CACHE.modelId,
          {
            revision: LEGACY_EMBEDDING_CACHE.revision,
            device: LEGACY_EMBEDDING_CACHE.device,
            dtype: LEGACY_EMBEDDING_CACHE.dtype,
          },
        )
        filesDeleted += legacy.filesDeleted
      } catch (error) {
        errors.push(error)
      }

      try {
        const legacy = await ModelRegistry.clear_pipeline_cache(
          LEGACY_NLI_CACHE.task,
          LEGACY_NLI_CACHE.modelId,
          {
            revision: LEGACY_NLI_CACHE.revision,
            device: LEGACY_NLI_CACHE.device,
            dtype: LEGACY_NLI_CACHE.dtype,
          },
        )
        filesDeleted += legacy.filesDeleted
      } catch (error) {
        errors.push(error)
      }

      filesDeleted += await deleteTokenizerMetadataAlias(
        this.config.modelId,
        this.config.revision,
      )
      filesDeleted += await deleteTokenizerMetadataAlias(
        LEGACY_EMBEDDING_CACHE.modelId,
        LEGACY_EMBEDDING_CACHE.revision,
      )
      filesDeleted += await deleteTokenizerMetadataAlias(
        LEGACY_NLI_CACHE.modelId,
        LEGACY_NLI_CACHE.revision,
      )
      this.loadSource = undefined
      this.setPhase("idle")

      if (errors.length > 0) {
        throw new Error(
          `Nicht alle Cache-Dateien konnten gelöscht werden: ${errors.map(errorMessage).join("; ")}`,
        )
      }
      return filesDeleted
    })
  }
}
