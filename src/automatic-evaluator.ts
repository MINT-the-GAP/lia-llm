import {
  captureNetworkSnapshot,
  decideModelDownload,
  requestModelDownloadConsent,
  requestPersistentStorage,
  type DownloadPolicyDecision,
} from "./download-policy.ts"
import { SemanticEvaluator } from "./evaluator.ts"
import { QualityEvaluator } from "./quality-evaluator.ts"
import { normalizeRequest } from "./scoring.ts"
import type {
  AssessmentEngine,
  EvaluationOptions,
  EvaluationProgress,
  EvaluationRequest,
  EvaluationResult,
  ModelCacheInfo,
  RuntimeConfig,
  RuntimeStatus,
} from "./types.ts"

interface LoadAuthorization {
  allowed: boolean
  decision: DownloadPolicyDecision
}

interface EvaluationRun {
  generation: number
  requestSignal?: AbortSignal
  lifecycleSignal: AbortSignal
}

function abortError(): Error {
  const error = new Error("Die Auswertung wurde beendet.")
  error.name = "AbortError"
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function assertRunActive(run: EvaluationRun): void {
  if (
    run.requestSignal?.aborted ||
    run.lifecycleSignal.aborted
  ) {
    throw abortError()
  }
}

function waitForRun<T>(promise: Promise<T>, run: EvaluationRun): Promise<T> {
  assertRunActive(run)
  const signals = [run.requestSignal, run.lifecycleSignal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  )
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      for (const signal of signals) signal.removeEventListener("abort", onAbort)
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = (): void => finish(() => reject(abortError()))
    for (const signal of signals) {
      signal.addEventListener("abort", onAbort, { once: true })
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

function snapshotRequest(request: EvaluationRequest): EvaluationRequest {
  return {
    ...request,
    criteria: Array.isArray(request.criteria)
      ? request.criteria.map((criterion) => ({
          ...criterion,
          acceptedVariants: criterion.acceptedVariants
            ? [...criterion.acceptedVariants]
            : undefined,
          misconceptions: criterion.misconceptions
            ? [...criterion.misconceptions]
            : undefined,
        }))
      : request.criteria,
  }
}

function emitStatus(status: RuntimeStatus): void {
  if (
    typeof globalThis.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  ) {
    return
  }
  globalThis.dispatchEvent(new CustomEvent("lia-llm:status", { detail: status }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function qualityPayloadCached(cache: ModelCacheInfo): boolean {
  return cache.downloadCached ?? cache.cached
}

function supportsQualityRuntime(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "gpu" in navigator &&
    Boolean((navigator as Navigator & { gpu?: unknown }).gpu)
  )
}

export class AutomaticEvaluator {
  private readonly compactEvaluator: SemanticEvaluator
  private readonly qualityEvaluator: QualityEvaluator
  private qualityReady = false
  private qualityDegraded = false
  private generation = 0
  private lifecycleController = new AbortController()
  private persistentStorage: boolean | undefined
  private persistenceRequested = false
  private compactPreparationPromise: Promise<void> | null = null
  private qualityCacheInfoPromise: Promise<ModelCacheInfo> | null = null
  private qualityUpgradePromise: Promise<boolean> | null = null
  private qualityEvaluationQueue: Promise<void> = Promise.resolve()
  private compactUsers = 0
  private compactUnloadPromise: Promise<void> | null = null
  private clearPromise: Promise<number> | null = null
  private readonly consentControllers = new Set<AbortController>()

  constructor(
    compactEvaluator = new SemanticEvaluator(),
    qualityEvaluator = new QualityEvaluator(),
  ) {
    this.compactEvaluator = compactEvaluator
    this.qualityEvaluator = qualityEvaluator
  }

  configure(config: Partial<RuntimeConfig>): RuntimeStatus {
    return this.compactEvaluator.configure(config)
  }

  getStatus(): RuntimeStatus {
    if (this.qualityReady && !this.qualityDegraded) {
      return this.qualityEvaluator.getStatus()
    }
    return this.compactEvaluator.getStatus()
  }

  private async waitForClear(): Promise<void> {
    const clearing = this.clearPromise
    if (clearing) await clearing
  }

  private reportProgress(
    options: EvaluationOptions | undefined,
    run: EvaluationRun,
    progress: EvaluationProgress,
  ): void {
    if (
      !options?.onProgress ||
      run.requestSignal?.aborted ||
      run.lifecycleSignal.aborted ||
      run.generation !== this.generation
    ) {
      return
    }
    try {
      options.onProgress(progress)
    } catch {
      // A UI callback must never affect the assessment.
    }
  }

  private releaseCompactIfIdle(): void {
    if (
      !this.qualityReady ||
      this.qualityDegraded ||
      this.compactUsers > 0 ||
      this.compactUnloadPromise
    ) {
      return
    }
    const unload = this.compactEvaluator
      .unloadRuntime()
      .catch(() => undefined)
      .finally(() => {
        if (this.compactUnloadPromise === unload) {
          this.compactUnloadPromise = null
        }
      })
    this.compactUnloadPromise = unload
  }

  private async askForConsent(
    engine: AssessmentEngine,
    status: RuntimeStatus,
    cache: ModelCacheInfo,
  ): Promise<boolean> {
    const controller = new AbortController()
    this.consentControllers.add(controller)
    try {
      return await requestModelDownloadConsent(
        {
          engine,
          modelName: status.modelId,
          estimatedBytes: cache.estimatedBytes,
        },
        controller.signal,
      )
    } finally {
      this.consentControllers.delete(controller)
    }
  }

  private async authorizeLoad(
    engine: AssessmentEngine,
    status: RuntimeStatus,
    cache: ModelCacheInfo,
  ): Promise<LoadAuthorization> {
    const downloadCached = cache.downloadCached ?? cache.cached
    const decision = decideModelDownload({
      engine,
      cached: downloadCached,
      network: captureNetworkSnapshot(),
    })
    if (decision === "skip") return { allowed: false, decision }

    const allowed =
      decision === "auto" ||
      (await this.askForConsent(engine, status, cache))
    if (allowed && !downloadCached && !this.persistenceRequested) {
      this.persistenceRequested = true
      this.persistentStorage = await requestPersistentStorage()
    }
    return { allowed, decision }
  }

  private async ensureCompact(): Promise<void> {
    if (this.compactEvaluator.getStatus().phase === "ready") return
    if (this.compactPreparationPromise) {
      await this.compactPreparationPromise
      return
    }

    const generation = this.generation
    const preparation = (async () => {
      const cache = await this.compactEvaluator.getCacheInfo()
      const authorization = await this.authorizeLoad(
        "compact",
        this.compactEvaluator.getStatus(),
        cache,
      )
      if (!authorization.allowed) {
        if (authorization.decision === "skip") {
          throw new Error(
            "Das Kompaktmodell ist offline noch nicht vollständig im Browsercache verfügbar.",
          )
        }
        throw new Error("Der Download des Kompaktmodells wurde abgebrochen.")
      }
      if (generation !== this.generation) {
        throw new Error("Das Laden des Kompaktmodells wurde beendet.")
      }
      await this.compactEvaluator.preload(cache)
    })()
    this.compactPreparationPromise = preparation

    try {
      await preparation
    } finally {
      if (this.compactPreparationPromise === preparation) {
        this.compactPreparationPromise = null
      }
    }
  }

  private getQualityCacheInfo(): Promise<ModelCacheInfo> {
    if (this.qualityCacheInfoPromise) return this.qualityCacheInfoPromise

    const probe = this.qualityEvaluator.getCacheInfo()
    this.qualityCacheInfoPromise = probe
    void probe.catch(() => {
      if (this.qualityCacheInfoPromise === probe) {
        this.qualityCacheInfoPromise = null
      }
    })
    return probe
  }

  private markQualityDegraded(generation: number): void {
    if (generation !== this.generation) return
    this.qualityReady = false
    this.qualityDegraded = true
    emitStatus(this.compactEvaluator.getStatus())
  }

  private async upgradeQuality(
    generation: number,
    knownCache?: ModelCacheInfo,
  ): Promise<boolean> {
    if (!supportsQualityRuntime()) {
      this.markQualityDegraded(generation)
      return false
    }

    const cache = knownCache ?? (await this.getQualityCacheInfo())
    const authorization = await this.authorizeLoad(
      "quality",
      this.qualityEvaluator.getStatus(),
      cache,
    )
    if (!authorization.allowed || generation !== this.generation) {
      this.markQualityDegraded(generation)
      return false
    }

    await this.qualityEvaluator.preload(cache)
    if (generation !== this.generation) return false

    this.qualityReady = true
    this.qualityDegraded = false
    this.releaseCompactIfIdle()
    return true
  }

  private startQualityUpgrade(knownCache?: ModelCacheInfo): Promise<boolean> {
    if (this.qualityReady && !this.qualityDegraded) {
      return Promise.resolve(true)
    }
    if (this.qualityDegraded) return Promise.resolve(false)
    if (this.qualityUpgradePromise) return this.qualityUpgradePromise

    const generation = this.generation
    const upgrade = this.upgradeQuality(generation, knownCache).catch(() => {
      if (generation === this.generation) {
        this.qualityReady = false
        this.qualityCacheInfoPromise = null
        emitStatus(this.compactEvaluator.getStatus())
      }
      return false
    })
    let tracked: Promise<boolean>
    tracked = upgrade.finally(() => {
      if (this.qualityUpgradePromise === tracked) {
        this.qualityUpgradePromise = null
      }
    })
    this.qualityUpgradePromise = tracked
    return tracked
  }

  private async evaluateCompact(
    request: EvaluationRequest,
    options: EvaluationOptions | undefined,
    run: EvaluationRun,
  ): Promise<EvaluationResult> {
    this.compactUsers += 1
    try {
      this.reportProgress(options, run, {
        phase: "preparing-compact",
        engine: "compact",
        message: "Kompaktmodell wird vorbereitet …",
      })
      await waitForRun(this.ensureCompact(), run)
      assertRunActive(run)
      this.reportProgress(options, run, {
        phase: "evaluating-compact",
        engine: "compact",
        message: "Antwort wird schnell geprüft …",
      })
      return await waitForRun(this.compactEvaluator.evaluate(request), run)
    } finally {
      this.compactUsers -= 1
      this.releaseCompactIfIdle()
    }
  }

  private evaluateQualityWithFallback(
    request: EvaluationRequest,
    options: EvaluationOptions | undefined,
    run: EvaluationRun,
    compactFallback?: EvaluationResult,
  ): Promise<EvaluationResult> {
    const generation = this.generation
    const fallback = async (): Promise<EvaluationResult> => {
      assertRunActive(run)
      this.reportProgress(options, run, {
        phase: "fallback-compact",
        engine: "compact",
        message: "Prüfung wird mit dem Kompaktmodell abgeschlossen …",
      })
      if (compactFallback) return compactFallback
      return this.evaluateCompact(request, options, run)
    }
    const task = async (): Promise<EvaluationResult> => {
      assertRunActive(run)
      if (
        generation !== this.generation ||
        !this.qualityReady ||
        this.qualityDegraded
      ) {
        return fallback()
      }
      this.reportProgress(options, run, {
        phase: "evaluating-quality",
        engine: "quality",
        message: "Antwort wird gründlich geprüft …",
      })
      try {
        return await waitForRun(this.qualityEvaluator.evaluate(request), run)
      } catch (error) {
        if (isAbortError(error)) throw error
        this.markQualityDegraded(generation)
        return fallback()
      }
    }
    const evaluation = this.qualityEvaluationQueue.then(
      task,
      task,
    )
    this.qualityEvaluationQueue = evaluation.then(
      () => undefined,
      () => undefined,
    )
    return waitForRun(evaluation, run)
  }

  async preload(): Promise<RuntimeStatus> {
    await this.waitForClear()
    const generation = this.generation
    let qualityCache: ModelCacheInfo | undefined
    try {
      qualityCache = await this.getQualityCacheInfo()
    } catch {
      // Der Kompaktpfad bleibt auch bei einer fehlgeschlagenen Cacheprobe nutzbar.
    }
    if (generation !== this.generation) throw abortError()

    if (
      qualityCache &&
      qualityPayloadCached(qualityCache) &&
      supportsQualityRuntime()
    ) {
      const available = await this.startQualityUpgrade(qualityCache)
      if (generation !== this.generation) throw abortError()
      if (available) return this.qualityEvaluator.getStatus()
    }

    await this.ensureCompact()
    if (generation !== this.generation) throw abortError()
    void this.startQualityUpgrade(qualityCache)
    return this.compactEvaluator.getStatus()
  }

  async evaluate(
    originalRequest: EvaluationRequest,
    options?: EvaluationOptions,
  ): Promise<EvaluationResult> {
    const request = snapshotRequest(originalRequest)
    normalizeRequest(request)
    await this.waitForClear()
    const run: EvaluationRun = {
      generation: this.generation,
      requestSignal: options?.signal,
      lifecycleSignal: this.lifecycleController.signal,
    }
    assertRunActive(run)

    this.reportProgress(options, run, {
      phase: "selecting-model",
      engine: this.qualityReady ? "quality" : "compact",
      message: "Passendes Modell wird ausgewählt …",
    })

    if (
      this.qualityReady &&
      !this.qualityDegraded
    ) {
      return this.evaluateQualityWithFallback(request, options, run)
    }

    let qualityCache: ModelCacheInfo | undefined
    try {
      qualityCache = await waitForRun(this.getQualityCacheInfo(), run)
    } catch (error) {
      if (isAbortError(error)) throw error
    }
    assertRunActive(run)

    if (this.qualityReady && !this.qualityDegraded) {
      return this.evaluateQualityWithFallback(request, options, run)
    }

    if (
      qualityCache &&
      qualityPayloadCached(qualityCache) &&
      supportsQualityRuntime() &&
      !this.qualityDegraded
    ) {
      this.reportProgress(options, run, {
        phase: "preparing-quality",
        engine: "quality",
        message: "Qualitätsprüfung wird vorbereitet …",
      })
      const qualityAvailable = await waitForRun(
        this.startQualityUpgrade(qualityCache),
        run,
      )
      assertRunActive(run)
      if (qualityAvailable) {
        return this.evaluateQualityWithFallback(request, options, run)
      }
    }

    const compactResult = await this.evaluateCompact(request, options, run)
    assertRunActive(run)
    const qualityUpgrade = this.startQualityUpgrade(qualityCache)
    if (compactResult.passed) return compactResult

    this.reportProgress(options, run, {
      phase: "preparing-quality",
      engine: "quality",
      message: "Qualitätsprüfung wird vorbereitet …",
    })
    const qualityAvailable = await waitForRun(qualityUpgrade, run)
    assertRunActive(run)
    if (!qualityAvailable || run.generation !== this.generation) {
      return compactResult
    }
    return this.evaluateQualityWithFallback(
      request,
      options,
      run,
      compactResult,
    )
  }

  async getCacheInfo(): Promise<ModelCacheInfo> {
    const [compact, quality] = await Promise.all([
      this.compactEvaluator.getCacheInfo(),
      this.qualityEvaluator.getCacheInfo(),
    ])

    if (
      this.persistentStorage === undefined &&
      typeof navigator !== "undefined" &&
      typeof navigator.storage?.persisted === "function"
    ) {
      try {
        this.persistentStorage = await navigator.storage.persisted()
      } catch {
        this.persistentStorage = false
      }
    }

    const errors = [compact.error, quality.error].filter(
      (value): value is string => Boolean(value),
    )
    return {
      supported: compact.supported && quality.supported,
      cached: compact.cached && quality.cached,
      downloadCached:
        (compact.downloadCached ?? compact.cached) &&
        (quality.downloadCached ?? quality.cached),
      filesCached: compact.filesCached + quality.filesCached,
      filesTotal: compact.filesTotal + quality.filesTotal,
      estimatedBytes: compact.estimatedBytes + quality.estimatedBytes,
      persistent: this.persistentStorage,
      engines: { compact, quality },
      error: errors.length > 0 ? errors.join("; ") : undefined,
    }
  }

  async clearCache(): Promise<number> {
    if (this.clearPromise) return this.clearPromise

    this.generation += 1
    this.lifecycleController.abort()
    this.lifecycleController = new AbortController()
    for (const controller of this.consentControllers) controller.abort()
    this.consentControllers.clear()
    this.qualityReady = false
    this.qualityDegraded = false
    this.persistentStorage = undefined
    this.persistenceRequested = false
    this.compactPreparationPromise = null
    this.qualityCacheInfoPromise = null
    this.qualityUpgradePromise = null
    this.compactUnloadPromise = null

    let clearing!: Promise<number>
    clearing = (async () => {
      const results = await Promise.allSettled([
        this.compactEvaluator.clearCache(),
        this.qualityEvaluator.clearCache(),
      ])
      const errors: string[] = []
      let deleted = 0
      for (const result of results) {
        if (result.status === "fulfilled") deleted += result.value
        else errors.push(errorMessage(result.reason))
      }
      if (errors.length > 0) {
        throw new Error(
          `Nicht alle Modellcaches konnten gelöscht werden: ${errors.join("; ")}`,
        )
      }
      return deleted
    })().finally(() => {
      if (this.clearPromise === clearing) this.clearPromise = null
    })
    this.clearPromise = clearing
    return clearing
  }
}
