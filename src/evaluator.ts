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
import { unavailableLanguageAnalysis } from "./language-analysis.ts"
import {
  beginDebugLoad,
  instrumentDebugFetch,
  recordDebugActivity,
  recordDebugCache,
  recordDebugFailure,
  recordDebugRetry,
} from "./debug-diagnostics.ts"
import {
  aggregateCriteria,
  bestReferenceVariantIndex,
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

// Keep the runtime factory and WASM paired with the onnxruntime-web version
// bundled into this release. Update this immutable ref together with that
// dependency and the checked-in dist assets.
export const PINNED_RUNTIME_ASSET_BASE_URL =
  "https://raw.githubusercontent.com/MINT-the-GAP/lia-llm/0838e25f4da7ec8267637966ef747ef568517748/dist/"

const LIA_LLM_BUNDLE_PATH_PATTERN =
  /(?:^|\/)lia-llm\/(?:.*\/)?dist\/index\.js$/iu
const LOCAL_BUNDLE_PATH_PATTERN = /\/dist\/index\.js$/iu
const RAW_LIA_LLM_SOURCE_PATH_PATTERN =
  /^\/MINT-the-GAP\/lia-llm\/(refs\/(?:heads|tags)\/.+|[\da-f]{40}|main)\/(README\.md|dist\/index\.js)$/iu

function assetDirectoryUrl(source: string | undefined): string | undefined {
  if (!source) return undefined
  try {
    const url = new URL(source)
    if (
      url.protocol === "blob:" ||
      url.protocol === "data:" ||
      url.protocol === "javascript:"
    ) {
      return undefined
    }
    return new URL(".", url).href
  } catch {
    return undefined
  }
}

function explicitAssetBaseUrl(source: string | undefined): string | undefined {
  if (!source) return undefined
  try {
    const url = new URL(source)
    if (
      url.protocol === "blob:" ||
      url.protocol === "data:" ||
      url.protocol === "javascript:"
    ) {
      return undefined
    }
    url.search = ""
    url.hash = ""
    if (!url.pathname.endsWith("/")) url.pathname += "/"
    return url.href
  } catch {
    return undefined
  }
}

function isLoopbackUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  )
}

function knownRuntimeAssetBaseUrl(source: string | undefined): string | undefined {
  if (!source) return undefined
  try {
    const url = new URL(source)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined

    if (url.hostname === "raw.githubusercontent.com") {
      const match = url.pathname.match(RAW_LIA_LLM_SOURCE_PATH_PATTERN)
      if (!match) return undefined
      const revision = match[1] ?? ""
      const sourcePath = match[2] ?? ""
      if (!/^[\da-f]{40}$/iu.test(revision)) {
        // A LiaScript import normally exposes refs/heads/main in resource
        // timing. The runtime must nevertheless stay paired with this bundle.
        return PINNED_RUNTIME_ASSET_BASE_URL
      }
      return sourcePath === "README.md"
        ? new URL("./dist/", url).href
        : new URL(".", url).href
    }

    if (
      LIA_LLM_BUNDLE_PATH_PATTERN.test(url.pathname) ||
      (isLoopbackUrl(url) && LOCAL_BUNDLE_PATH_PATTERN.test(url.pathname))
    ) {
      return new URL(".", url).href
    }

  } catch {
    // Ignore malformed resource and script URLs.
  }
  return undefined
}

export function resolveRuntimeAssetBaseUrl(
  currentSource: string | undefined,
  resourceSources: readonly string[],
  scriptSources: readonly string[],
  overrideBaseUrl?: string,
): string {
  const overrideBase = explicitAssetBaseUrl(overrideBaseUrl)
  if (overrideBase) return overrideBase

  const currentBase = assetDirectoryUrl(currentSource)
  if (currentBase) return currentBase

  // LiaScript fetches metadata scripts and executes their source through a
  // blob URL. Prefer a narrowly matched lia-llm bundle or imported README
  // when its original URL is still visible in resource timing.
  for (let index = resourceSources.length - 1; index >= 0; index -= 1) {
    const source = resourceSources[index]
    const base = knownRuntimeAssetBaseUrl(source)
    if (base) return base
  }

  for (let index = scriptSources.length - 1; index >= 0; index -= 1) {
    const source = scriptSources[index]
    const base = knownRuntimeAssetBaseUrl(source)
    if (base) return base
  }
  return PINNED_RUNTIME_ASSET_BASE_URL
}

const runtimeAssetBaseUrl = (() => {
  if (typeof document === "undefined") {
    return resolveRuntimeAssetBaseUrl(undefined, [], [])
  }
  const currentSource = (document.currentScript as HTMLScriptElement | null)?.src
  let resourceSources: string[] = []
  try {
    resourceSources =
      typeof performance === "undefined"
        ? []
        : performance.getEntriesByType("resource").map((entry) => entry.name)
  } catch {
    // Resource timing can be unavailable in restricted browser contexts.
  }
  return resolveRuntimeAssetBaseUrl(
    currentSource,
    resourceSources,
    Array.from(document.scripts, (script) => script.src),
  )
})()

const ORT_FACTORY_FILENAME = "ort-wasm-simd-threaded.asyncify.mjs"
const ORT_WASM_FILENAME = "ort-wasm-simd-threaded.asyncify.wasm"
const RUNTIME_ASSET_CACHE_PREFIX = "lia-llm-ort-runtime-"
export const RUNTIME_ASSET_CACHE_KEY =
  `${RUNTIME_ASSET_CACHE_PREFIX}0838e25f4da7ec8267637966ef747ef568517748`

export const RUNTIME_ASSETS = [
  {
    filename: ORT_FACTORY_FILENAME,
    label: "MJS",
    contentType: "text/javascript",
    byteLength: 47_389,
    sha256: "5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9",
  },
  {
    filename: ORT_WASM_FILENAME,
    label: "WASM",
    contentType: "application/wasm",
    byteLength: 23_567_050,
    sha256: "e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786",
  },
] as const
const RUNTIME_ASSET_ESTIMATED_BYTES = RUNTIME_ASSETS.reduce(
  (total, asset) => total + asset.byteLength,
  0,
)
const COMPACT_CACHE_ESTIMATED_BYTES =
  DEFAULT_MODEL_ESTIMATED_BYTES + RUNTIME_ASSET_ESTIMATED_BYTES

let localOnnxRuntimePromise: Promise<void> | null = null
let onnxWasmProxyMode: boolean | null = null

class OnnxWasmProxyModeError extends Error {
  override name = "OnnxWasmProxyModeError"
}

export function runtimeAssetUrl(filename: string): string {
  return new URL(filename, runtimeAssetBaseUrl).href
}

function configureLocalOnnxRuntime(): void {
  if (!env.backends.onnx.wasm) return
  env.backends.onnx.wasm.wasmPaths = {
    mjs: runtimeAssetUrl(ORT_FACTORY_FILENAME),
    wasm: runtimeAssetUrl(ORT_WASM_FILENAME),
  }
}

export function configureOnnxWasmProxy(enabled: boolean): void {
  if (!env.backends.onnx.wasm) return
  if (onnxWasmProxyMode !== null && onnxWasmProxyMode !== enabled) {
    throw new OnnxWasmProxyModeError(
      "Der ONNX-Laufzeitmodus ist für diese Seitensitzung bereits festgelegt. Für einen Wechsel zwischen WebGPU und WASM-Worker muss die Seite neu geladen werden.",
    )
  }
  // ONNX Runtime must choose proxy mode before its first session. Keep WebGPU
  // outside the proxy worker because the worker only supports WASM.
  env.backends.onnx.wasm.proxy = enabled
  onnxWasmProxyMode = enabled
}

export function isOnnxRuntimeEnvironmentError(error: unknown): boolean {
  if (error instanceof OnnxWasmProxyModeError) return true
  return /Content Security Policy|\bCSP\b|worker-src|script-src|blob:|Failed to construct ['"]?Worker|SecurityError|worker not ready|initWasm|WebAssembly\.(?:compile|instantiate)|CompileError|LinkError|no available backend/iu.test(
    errorMessage(error),
  )
}

function requestedOnnxWasmProxyMode(config: RuntimeConfig): boolean | null {
  if (config.device === "wasm") return true
  const hasWebGpu =
    typeof navigator !== "undefined" &&
    "gpu" in (navigator as Navigator & { gpu?: unknown })
  if (hasWebGpu) return false
  return config.fallbackToWasm ? true : null
}

interface RuntimeAssetCacheInfo {
  supported: boolean
  filesCached: number
  filesTotal: number
  allCached: boolean
  error?: string
}

export async function openRuntimeAssetCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") {
    recordDebugCache("compact", "runtime-open", "unsupported")
    return null
  }
  try {
    const cache = await caches.open(RUNTIME_ASSET_CACHE_KEY)
    recordDebugCache("compact", "runtime-open", "ok", {
      cacheName: RUNTIME_ASSET_CACHE_KEY,
    })
    return cache
  } catch (error) {
    recordDebugCache("compact", "runtime-open", "error", { error })
    return null
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  try {
    if (typeof crypto === "undefined") return null
    const subtle = crypto.subtle
    if (!subtle) return null
    const digest = await subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("")
  } catch {
    return null
  }
}

type RuntimeAssetValidation = "invalid" | "structural" | "verified"

async function validateRuntimeAsset(
  filename: string,
  bytes: ArrayBuffer,
): Promise<RuntimeAssetValidation> {
  const asset = RUNTIME_ASSETS.find((candidate) => candidate.filename === filename)
  if (!asset || bytes.byteLength !== asset.byteLength) return "invalid"
  const view = new Uint8Array(bytes)
  if (filename === ORT_WASM_FILENAME) {
    if (
      !(
        view[0] === 0x00 &&
        view[1] === 0x61 &&
        view[2] === 0x73 &&
        view[3] === 0x6d &&
        view[4] === 0x01 &&
        view[5] === 0x00 &&
        view[6] === 0x00 &&
        view[7] === 0x00
      )
    ) {
      return "invalid"
    }
  }
  if (filename === ORT_FACTORY_FILENAME) {
    const code = new TextDecoder().decode(view)
    if (
      !code.startsWith("async function ortWasmThreaded") ||
      !code.includes("export default ortWasmThreaded")
    ) {
      return "invalid"
    }
  }
  const digest = await sha256Hex(bytes)
  if (digest === null) return "structural"
  return digest === asset.sha256 ? "verified" : "invalid"
}

export async function isValidRuntimeAsset(
  filename: string,
  bytes: ArrayBuffer,
): Promise<boolean> {
  return (await validateRuntimeAsset(filename, bytes)) === "verified"
}

async function readCachedRuntimeAsset(
  cache: Cache | null,
  url: string,
  filename: string,
): Promise<ArrayBuffer | null> {
  if (!cache) return null
  try {
    const response = await cache.match(url)
    if (!response?.ok) {
      recordDebugCache("compact", "runtime-match", "miss", { url })
      return null
    }
    const bytes = await response.arrayBuffer()
    const validation = await validateRuntimeAsset(filename, bytes)
    const asset = RUNTIME_ASSETS.find(
      (candidate) => candidate.filename === filename,
    )
    if (
      validation === "verified" ||
      (validation === "structural" &&
        asset &&
        response.headers.get("X-Lia-LLM-Runtime-Cache") === "verified" &&
        response.headers.get("X-Lia-LLM-SHA256") === asset.sha256)
    ) {
      recordDebugCache("compact", "runtime-match", "hit", {
        url,
        details: { bytes: bytes.byteLength, validation },
      })
      return bytes
    }
    recordDebugCache("compact", "runtime-match", "corrupt", {
      url,
      details: { bytes: bytes.byteLength, validation },
    })
    const deleted = await cache.delete(url)
    recordDebugCache("compact", "runtime-delete", deleted ? "ok" : "miss", {
      url,
    })
  } catch (error) {
    recordDebugCache("compact", "runtime-match", "error", { url, error })
    // A broken or unavailable cache must not block online loading.
  }
  return null
}

async function cacheRuntimeAsset(
  cache: Cache | null,
  url: string,
  bytes: ArrayBuffer,
  asset: (typeof RUNTIME_ASSETS)[number],
): Promise<void> {
  if (!cache) return
  try {
    await cache.put(
      url,
      new Response(bytes.slice(0), {
        status: 200,
        headers: {
          "Content-Type": asset.contentType,
          "Content-Length": String(bytes.byteLength),
          "X-Lia-LLM-Runtime-Cache": "verified",
          "X-Lia-LLM-SHA256": asset.sha256,
        },
      }),
    )
    recordDebugCache("compact", "runtime-put", "ok", {
      url,
      details: { bytes: bytes.byteLength },
    })
  } catch (error) {
    recordDebugCache("compact", "runtime-put", "error", { url, error })
    // CacheStorage is best effort. The current online run can still continue.
  }
}

export async function loadRuntimeAsset(
  session: ResilientFetchSession,
  cache: Cache | null,
  asset: (typeof RUNTIME_ASSETS)[number],
): Promise<ArrayBuffer> {
  const url = runtimeAssetUrl(asset.filename)
  const cached = await readCachedRuntimeAsset(cache, url, asset.filename)
  if (cached) return cached

  // Runtime assets have an immutable logical size and SHA-256. Supplying the
  // logical size avoids comparing a browser-decoded body with a compressed
  // Content-Length that a restrictive cross-origin proxy may expose.
  const response = await session.fetchExact(url, asset.byteLength)
  if (!response.ok) {
    throw new Error(`${asset.label} ${response.status}`)
  }
  const bytes = await response.arrayBuffer()
  const validation = await validateRuntimeAsset(asset.filename, bytes)
  if (validation === "invalid") {
    recordDebugFailure(
      "compact",
      {
        url,
        expectedBytes: asset.byteLength,
        error: new Error(asset.label + " failed integrity validation"),
      },
      "runtime-integrity",
    )
  }
  if (validation === "invalid") {
    throw new Error(`${asset.label} enthielt kein gültiges ONNX-Artefakt`)
  }
  recordDebugCache("compact", "runtime-validate", validation, {
    url,
    details: { expected: asset.byteLength, received: bytes.byteLength },
  })
  if (validation === "verified") {
    await cacheRuntimeAsset(cache, url, bytes, asset)
  }
  return bytes
}

async function getRuntimeAssetCacheInfo(): Promise<RuntimeAssetCacheInfo> {
  const filesTotal = RUNTIME_ASSETS.length
  if (typeof caches === "undefined") {
    recordDebugCache("compact", "runtime-cache-probe", "unsupported")
    return { supported: false, filesCached: 0, filesTotal, allCached: false }
  }
  try {
    const cache = await caches.open(RUNTIME_ASSET_CACHE_KEY)
    const matches = await Promise.all(
      RUNTIME_ASSETS.map((asset) =>
        readCachedRuntimeAsset(
          cache,
          runtimeAssetUrl(asset.filename),
          asset.filename,
        ),
      ),
    )
    const filesCached = matches.filter(Boolean).length
    return {
      supported: true,
      filesCached,
      filesTotal,
      allCached: filesCached === filesTotal,
    }
  } catch (error) {
    recordDebugCache("compact", "runtime-cache-probe", "error", { error })
    return {
      supported: false,
      filesCached: 0,
      filesTotal,
      allCached: false,
      error: errorMessage(error),
    }
  }
}

export async function clearRuntimeAssetCache(): Promise<number> {
  if (typeof caches === "undefined") return 0
  let cacheNames: string[]
  try {
    cacheNames = (await caches.keys()).filter((name) =>
      name.startsWith(RUNTIME_ASSET_CACHE_PREFIX),
    )
  } catch {
    return 0
  }

  let filesDeleted = 0
  for (const cacheName of cacheNames) {
    try {
      const cache = await caches.open(cacheName)
      const fileCount = (await cache.keys()).length
      if (await caches.delete(cacheName)) filesDeleted += fileCount
    } catch {
      // Keep counting other versioned runtime caches independently.
    }
  }
  return filesDeleted
}

async function prepareLocalOnnxRuntime(
  session: ResilientFetchSession,
): Promise<void> {
  const wasmOptions = env.backends.onnx.wasm
  if (!wasmOptions || wasmOptions.wasmBinary) return
  if (!localOnnxRuntimePromise) {
    localOnnxRuntimePromise = (async () => {
      const cache = await openRuntimeAssetCache()
      let factoryBytes: ArrayBuffer
      let wasmBinary: ArrayBuffer
      try {
        ;[factoryBytes, wasmBinary] = await Promise.all([
          loadRuntimeAsset(session, cache, RUNTIME_ASSETS[0]),
          loadRuntimeAsset(session, cache, RUNTIME_ASSETS[1]),
        ])
      } catch (error) {
        throw new Error(
          `Die lokale ONNX-Laufzeit konnte nicht geladen werden (${errorMessage(error)}).`,
        )
      }
      const factoryCode = new TextDecoder().decode(factoryBytes)
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

export function finalizeCompactAssessment(
  assessment: ReturnType<typeof aggregateCriteria>,
  hasOperator: boolean,
  criteria: readonly CriterionResult[],
): {
  assessment: ReturnType<typeof aggregateCriteria>
  diagnostic: EvaluationDiagnostic | undefined
} {
  if (hasOperator && assessment.passed) {
    return {
      assessment: {
        ...assessment,
        status: "uncertain",
        passed: false,
      },
      diagnostic: {
        code: "operator-check-unavailable",
        source: "compact",
        severity: "blocking",
      },
    }
  }
  return {
    assessment,
    diagnostic: compactDiagnostic(
      assessment.status,
      assessment.passed,
      criteria,
    ),
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

const DEFAULT_COMPACT_MODEL_CACHE_FILES = [
  "config.json",
  "tokenizer_config.json",
  "tokenizer.json",
  "onnx/model_quantized.onnx",
] as const

export function defaultCompactModelCacheUrls(): string[] {
  return DEFAULT_COMPACT_MODEL_CACHE_FILES.map((file) =>
    hubUrl(DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION, file),
  )
}

export async function checkDefaultCompactModelCache(): Promise<{
  allCached: boolean
  files: Array<{ file: string; cached: boolean }>
}> {
  if (typeof caches === "undefined") {
    throw new Error("Browser cache is not available in this environment.")
  }
  const cache = await caches.open(env.cacheKey)
  const urls = defaultCompactModelCacheUrls()
  const files = await Promise.all(
    DEFAULT_COMPACT_MODEL_CACHE_FILES.map(async (file, index) => ({
      file,
      cached: (await cache.match(urls[index]!))?.ok === true,
    })),
  )
  return {
    allCached: files.every((file) => file.cached),
    files,
  }
}

const PINNED_METADATA_ALIASES = ["config.json", "tokenizer_config.json"] as const

async function aliasPinnedMetadata(
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
    for (const filename of PINNED_METADATA_ALIASES) {
      const pinnedUrl = hubUrl(modelId, revision, filename)
      const mainUrl = hubUrl(modelId, "main", filename)
      const pinned = await cache.match(pinnedUrl)
      if (pinned) {
        await cache.put(mainUrl, pinned.clone())
      }
    }
  } catch {
    // Best effort: online loading still works without these metadata aliases.
  }
}

async function deletePinnedMetadataAliases(
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
    const deleted = await Promise.all(
      PINNED_METADATA_ALIASES.map((filename) =>
        cache.delete(hubUrl(modelId, "main", filename)),
      ),
    )
    return deleted.filter(Boolean).length
  } catch {
    return 0
  }
}

function modelCacheUrlPrefix(modelId: string): string {
  const revisionToken = "{revision}"
  const path = env.remotePathTemplate.replaceAll("{model}", modelId)
  const revisionIndex = path.indexOf(revisionToken)
  const prefix =
    revisionIndex < 0 ? path : path.slice(0, revisionIndex)
  return new URL(prefix, env.remoteHost).href
}

async function clearCachedModels(modelIds: readonly string[]): Promise<number> {
  if (typeof caches === "undefined" || !env.useBrowserCache) return 0
  const cache = await caches.open(env.cacheKey)
  const prefixes = [...new Set(modelIds)].map(modelCacheUrlPrefix)
  const requests = await cache.keys()
  let filesDeleted = 0
  for (const request of requests) {
    if (
      prefixes.some((prefix) => request.url.startsWith(prefix)) &&
      (await cache.delete(request))
    ) {
      filesDeleted += 1
    }
  }
  return filesDeleted
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
    env.useBrowserCache = typeof caches !== "undefined"
    // ORT is shipped with this exact bundle and persisted by the versioned
    // cache above. Keep the library preload disabled to avoid its fragile
    // fetch -> response.clone() -> Cache.put() path seen in Edge.
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

    const requestedProxyMode = requestedOnnxWasmProxyMode(merged)
    if (
      requestedProxyMode !== null &&
      onnxWasmProxyMode !== null &&
      requestedProxyMode !== onnxWasmProxyMode
    ) {
      throw new OnnxWasmProxyModeError(
        "Der ONNX-Laufzeitmodus ist für diese Seitensitzung bereits festgelegt. Für einen Wechsel zwischen WebGPU und WASM-Worker muss die Seite neu geladen werden.",
      )
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
    const diagnosticFetch = instrumentDebugFetch(
      "compact",
      globalThis.fetch.bind(globalThis),
    )
    const session = new ResilientFetchSession(diagnosticFetch, {
      onActivity: (activity) => recordDebugActivity("compact", activity),
      onRetry: (retry) => {
        const { attempt } = retry
        recordDebugRetry("compact", retry)
        emit<ModelProgress>("lia-llm:progress", {
          status: "retry",
          message: `Netzwerkunterbrechung – Teil-Download wird erneut versucht (${attempt}).`,
        })
      },
      onFailure: (failure) => recordDebugFailure("compact", failure),
    })
    this.fetchSession = session
    env.fetch = session.fetch
    try {
      const proxyMode = requestedOnnxWasmProxyMode(this.config)
      if (proxyMode !== null) configureOnnxWasmProxy(proxyMode)
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

    // Transformers.js 4.2 discovers pipeline files with `main` metadata even
    // when the model itself is pinned. Aliasing the already cached immutable
    // metadata keeps cache inspection and deletion functional while offline.
    await aliasPinnedMetadata(this.config.modelId, this.config.revision)

    try {
      const labels = resolveNliLabels(model.config)
      this.config = { ...this.config, device, dtype }
      return { tokenizer, model, labels }
    } catch (error) {
      await model.dispose()
      throw error
    }
  }

  async preload(
    cacheInfo?: ModelCacheInfo,
    diagnosticRunStarted = false,
  ): Promise<RuntimeStatus> {
    if (this.runtime) return this.getStatus()
    if (!this.loadPromise) {
      if (!diagnosticRunStarted) beginDebugLoad("compact")
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
            !env.backends.onnx.wasm?.wasmBinary ||
            isOnnxRuntimeEnvironmentError(error)
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
          await deletePinnedMetadataAliases(
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

    const classifyBatch = async (
      batch: readonly NliPair[],
    ): Promise<NliEvidence[]> => {
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
        if (batch.length === 1) {
          const pair = batch[0]!
          return [{
            text: pair.premise,
            hypothesis: pair.hypothesis,
            entailment: 0,
            neutral: 1,
            contradiction: 0,
          }]
        }

        const splitResults: NliEvidence[] = []
        for (const pair of batch) {
          splitResults.push(...await classifyBatch([pair]))
        }
        return splitResults
      }

      let output: SequenceClassifierOutput | null = null
      try {
        const currentOutput = await runtime.model(inputs)
        output = currentOutput
        const rows = toLogitRows(currentOutput.logits, batch.length)
        return rows.map((row, index) => {
          const probabilities = Array.from(softmax(row))
          if (probabilities.length !== 3) {
            throw new Error(
              `Drei NLI-Klassen erwartet, ${probabilities.length} erhalten.`,
            )
          }
          const pair = batch[index]!
          return {
            text: pair.premise,
            hypothesis: pair.hypothesis,
            entailment: probabilities[runtime.labels.entailment]!,
            neutral: probabilities[runtime.labels.neutral]!,
            contradiction: probabilities[runtime.labels.contradiction]!,
          }
        })
      } finally {
        output?.logits.dispose()
        disposeInputs(inputs)
      }
    }

    const results: NliEvidence[] = []
    for (let offset = 0; offset < pairs.length; offset += this.config.batchSize) {
      const batch = pairs.slice(offset, offset + this.config.batchSize)
      results.push(...await classifyBatch(batch))
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
        const positiveCount =
          normalized.mode === "holistic" && normalized.references.length > 1
            ? normalized.references.length
            : uniqueTexts([
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

        if (normalized.mode === "holistic" && normalized.references.length > 1) {
          const positiveEvidence = await this.classifyPairs(
            normalized.references.flatMap((hypothesis) =>
              answerContexts.map((premise) => ({ premise, hypothesis })),
            ),
          )
          const candidateResults = normalized.references.map(
            (hypothesis, referenceIndex) => {
              const start = referenceIndex * answerContexts.length
              const evidence = positiveEvidence.slice(
                start,
                start + answerContexts.length,
              )
              return classifyCriterion({
                criterion: {
                  ...criterion,
                  text: hypothesis,
                  acceptedVariants: [],
                },
                supportEvidence: bestBy(
                  evidence,
                  (item) => item.entailment,
                ),
                contradictionEvidence: bestBy(
                  evidence,
                  (item) => item.contradiction,
                ),
                misconceptionEvidence,
                uncertaintyMargin: normalized.uncertaintyMargin,
                contrastiveMargin: normalized.contrastiveMargin,
              })
            },
          )
          const selectedReferenceIndex =
            bestReferenceVariantIndex(candidateResults)
          results.push({
            ...candidateResults[selectedReferenceIndex]!,
            selectedReferenceIndex,
          })
          continue
        }

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

      const finalized = finalizeCompactAssessment(
        aggregateCriteria(results, normalized.passThreshold),
        normalized.operator !== undefined,
        results,
      )
      return {
        ...finalized.assessment,
        mode: normalized.mode,
        criteria: results,
        answer: normalized.answer,
        selectedReferenceIndex: results[0]?.selectedReferenceIndex ?? 0,
        operator: normalized.operator,
        diagnostic: finalized.diagnostic,
        languageAnalysis: normalized.languageAnalysis
          ? unavailableLanguageAnalysis(
              normalized.answer,
              normalized.languageAnalysis,
            )
          : undefined,
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

  private usesDefaultCompactModelCache(): boolean {
    return (
      this.config.modelId === DEFAULT_MODEL_ID &&
      this.config.revision === DEFAULT_MODEL_REVISION &&
      this.config.device === "wasm" &&
      this.config.dtype === "q8"
    )
  }

  async getCacheInfo(): Promise<ModelCacheInfo> {
    if (typeof caches === "undefined") {
      recordDebugCache("compact", "model-cache-probe", "unsupported")
      return {
        supported: false,
        cached: false,
        downloadCached: false,
        filesCached: 0,
        filesTotal: 0,
        estimatedBytes: COMPACT_CACHE_ESTIMATED_BYTES,
      }
    }

    const usesDefaultCache = this.usesDefaultCompactModelCache()
    try {
      const modelCache = usesDefaultCache
        ? checkDefaultCompactModelCache()
        : ModelRegistry.is_pipeline_cached_files(
            NLI_TASK,
            this.config.modelId,
            this.registryOptions(),
          )
      const [result, runtimeCache] = await Promise.all([
        modelCache,
        getRuntimeAssetCacheInfo(),
      ])
      const files = result.files ?? []
      recordDebugCache(
        "compact",
        "model-cache-probe",
        result.allCached && runtimeCache.allCached ? "hit" : "partial",
        {
          details: {
            modelFilesCached: files.filter((file) => file.cached).length,
            modelFilesTotal: files.length,
            runtimeFilesCached: runtimeCache.filesCached,
            runtimeFilesTotal: runtimeCache.filesTotal,
          },
        },
      )
      return {
        supported: runtimeCache.supported,
        cached: result.allCached && runtimeCache.allCached,
        downloadCached: result.allCached,
        filesCached:
          files.filter((file) => file.cached).length + runtimeCache.filesCached,
        filesTotal: files.length + runtimeCache.filesTotal,
        estimatedBytes: COMPACT_CACHE_ESTIMATED_BYTES,
        error: runtimeCache.error,
      }
    } catch (error) {
      recordDebugCache("compact", "model-cache-probe", "error", { error })
      return {
        supported: !usesDefaultCache,
        cached: false,
        downloadCached: false,
        filesCached: 0,
        filesTotal: usesDefaultCache
          ? DEFAULT_COMPACT_MODEL_CACHE_FILES.length + RUNTIME_ASSETS.length
          : 0,
        estimatedBytes: COMPACT_CACHE_ESTIMATED_BYTES,
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
        filesDeleted += await clearCachedModels([
          this.config.modelId,
          LEGACY_EMBEDDING_CACHE.modelId,
          LEGACY_NLI_CACHE.modelId,
        ])
      } catch (error) {
        errors.push(error)
      }

      filesDeleted += await clearRuntimeAssetCache()
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
