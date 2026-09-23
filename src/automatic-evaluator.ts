import {
  captureNetworkSnapshot,
  decideModelDownload,
  requestModelDownloadConsent,
  requestPersistentStorage,
  type DownloadPolicyDecision,
} from "./download-policy.ts"
import {
  beginDebugLoad,
  recordDebugFailure,
  recordDebugPersistence,
  recordDebugPolicy,
} from "./debug-diagnostics.ts"
import { SemanticEvaluator } from "./evaluator.ts"
import {
  countWords,
  normalizeLanguageAnalysisOptions,
  unavailableLanguageAnalysis,
} from "./language-analysis.ts"
import {
  createAssessmentManipulationResult,
  createExactReferenceMatchResult,
  isFatalQualityEngineError,
  isQualityOutputError,
  isQualityWorkerTimeoutError,
  isRecoverableQualityRequestError,
  QualityEvaluator,
} from "./quality-evaluator.ts"
import { normalizeRequest } from "./scoring.ts"
import {
  normalizeAdaptiveThinkingLimits,
  normalizeThinkingLimits,
} from "./thinking-config.ts"
import type {
  AssessmentEngine,
  EvaluationOptions,
  EvaluationProgress,
  EvaluationRequest,
  EvaluationResult,
  LanguageAnalysisResult,
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

interface AutomaticEvaluatorTimings {
  uncachedQualityWaitMs: number
  cachedQualityWaitMs: number
  qualityCacheProbeWaitMs: number
}

const DEFAULT_AUTOMATIC_EVALUATOR_TIMINGS: AutomaticEvaluatorTimings = {
  uncachedQualityWaitMs: 30_000,
  cachedQualityWaitMs: 180_000,
  qualityCacheProbeWaitMs: 5_000,
}

type ForegroundWaitResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true }

function positiveWaitMs(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} muss eine positive ganze Millisekundenzahl sein.`)
  }
  return value
}

function explicitlyRequestsThinking(options?: EvaluationOptions): boolean {
  if (
    options?.maxThinkingTimeMs === undefined &&
    options?.maxThinkingTokens === undefined
  ) return false
  return normalizeThinkingLimits(options).maxTimeMs > 0
}

function requestedAssessmentEngine(value: unknown): AssessmentEngine | undefined {
  if (value === undefined) return undefined
  if (value === "compact" || value === "quality") return value
  throw new Error('assessmentEngine erwartet "compact" oder "quality".')
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

async function waitForRunWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  run: EvaluationRun,
): Promise<ForegroundWaitResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ForegroundWaitResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })
  const completion = promise.then<ForegroundWaitResult<T>>((value) => ({
    timedOut: false,
    value,
  }))
  try {
    return await waitForRun(Promise.race([completion, timeout]), run)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function linkRunSignals(run: EvaluationRun): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const signals = [...new Set(
    [run.requestSignal, run.lifecycleSignal].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    ),
  )]
  const onAbort = (): void => controller.abort()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener("abort", onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort)
      }
    },
  }
}

function snapshotRequest(request: EvaluationRequest): EvaluationRequest {
  return {
    ...request,
    referenceVariants: request.referenceVariants
      ? [...request.referenceVariants]
      : undefined,
    languageAnalysis: request.languageAnalysis
      ? { ...request.languageAnalysis }
      : undefined,
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

function withLanguageAnalysisFallback(
  request: EvaluationRequest,
  result: EvaluationResult,
): EvaluationResult {
  const languageOptions = normalizeLanguageAnalysisOptions(
    request.languageAnalysis,
  )
  if (!languageOptions || result.languageAnalysis) return result
  return {
    ...result,
    languageAnalysis: unavailableLanguageAnalysis(
      result.answer,
      languageOptions,
    ),
  }
}

function operatorSafeCompactResult(
  request: EvaluationRequest,
  result: EvaluationResult,
): EvaluationResult {
  const languageSafe = withLanguageAnalysisFallback(request, result)
  if (!request.operator?.trim()) return languageSafe
  return {
    ...languageSafe,
    status: "uncertain",
    passed: false,
    diagnostic: {
      code: "operator-check-unavailable",
      source: "compact",
      severity: "blocking",
    },
  }
}

function qualityUnavailableSafeCompactResult(
  request: EvaluationRequest,
  result: EvaluationResult,
): EvaluationResult {
  const operatorSafe = operatorSafeCompactResult(request, result)
  if (
    request.assessmentEngine !== "quality" ||
    result.mode !== "criteria" ||
    (result.status !== "failed" && result.status !== "uncertain") ||
    operatorSafe.diagnostic?.code === "operator-check-unavailable"
  ) {
    return operatorSafe
  }
  return {
    ...operatorSafe,
    status: "uncertain",
    passed: false,
    diagnostic: {
      code: "quality-check-unavailable",
      source: "compact",
      severity: "blocking",
    },
  }
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
  private qualityUpgradeController: AbortController | null = null
  private qualityUpgradeContinuesInBackground = false
  private qualityUpgradeEpoch = 0
  private readonly qualityUpgradeInterests = new Map<
    Promise<boolean>,
    Map<EvaluationRun, number>
  >()
  private qualityEvaluationQueue: Promise<void> = Promise.resolve()
  private activeLanguageController: AbortController | null = null
  private compactUsers = 0
  private compactUnloadPromise: Promise<void> | null = null
  private clearPromise: Promise<number> | null = null
  private readonly consentControllers = new Set<AbortController>()
  private readonly timings: AutomaticEvaluatorTimings

  constructor(
    compactEvaluator = new SemanticEvaluator(),
    qualityEvaluator = new QualityEvaluator(),
    timings: Partial<AutomaticEvaluatorTimings> = {},
  ) {
    this.compactEvaluator = compactEvaluator
    this.qualityEvaluator = qualityEvaluator
    this.timings = {
      uncachedQualityWaitMs: positiveWaitMs(
        "uncachedQualityWaitMs",
        timings.uncachedQualityWaitMs ??
          DEFAULT_AUTOMATIC_EVALUATOR_TIMINGS.uncachedQualityWaitMs,
      ),
      cachedQualityWaitMs: positiveWaitMs(
        "cachedQualityWaitMs",
        timings.cachedQualityWaitMs ??
          DEFAULT_AUTOMATIC_EVALUATOR_TIMINGS.cachedQualityWaitMs,
      ),
      qualityCacheProbeWaitMs: positiveWaitMs(
        "qualityCacheProbeWaitMs",
        timings.qualityCacheProbeWaitMs ??
          DEFAULT_AUTOMATIC_EVALUATOR_TIMINGS.qualityCacheProbeWaitMs,
      ),
    }
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

  private cancelActiveLanguageEvaluation(): void {
    this.activeLanguageController?.abort()
    this.activeLanguageController = null
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
    signal?: AbortSignal,
  ): Promise<boolean> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    this.consentControllers.add(controller)
    try {
      return await requestModelDownloadConsent(
        {
          engine,
          modelName: status.modelId,
          estimatedBytes: cache.estimatedBytes,
          qualitySelection: cache.qualitySelection,
        },
        controller.signal,
      )
    } finally {
      signal?.removeEventListener("abort", onAbort)
      this.consentControllers.delete(controller)
    }
  }

  private requestPersistenceInBackground(): void {
    if (this.persistenceRequested) return

    this.persistenceRequested = true
    const generation = this.generation
    void requestPersistentStorage().then(
      (persistent) => {
        recordDebugPersistence(persistent ? "granted" : "denied")
        if (generation === this.generation) {
          this.persistentStorage = persistent
        }
      },
      (error) => {
        recordDebugPersistence("error", error)
        if (generation === this.generation) {
          this.persistentStorage = false
        }
      },
    )
  }

  private async authorizeLoad(
    engine: AssessmentEngine,
    status: RuntimeStatus,
    cache: ModelCacheInfo,
    signal?: AbortSignal,
  ): Promise<LoadAuthorization> {
    const downloadCached = cache.downloadCached ?? cache.cached
    const network = captureNetworkSnapshot()
    const decision: DownloadPolicyDecision =
      engine === "quality" &&
      !downloadCached &&
      cache.qualitySelection?.sufficient === false
        ? "insufficient-storage"
        : decideModelDownload({
            engine,
            // Offline startup requires every runtime and metadata component,
            // not only the large payload represented by downloadCached.
            cached: cache.cached,
            network,
          })
    recordDebugPolicy(engine, decision, cache, network)
    if (decision === "skip" || decision === "insufficient-storage") {
      return { allowed: false, decision }
    }

    const allowed =
      decision === "auto" ||
      (await this.askForConsent(engine, status, cache, signal))
    if (decision === "consent") {
      recordDebugPolicy(
        engine,
        allowed ? "consent-accepted" : "consent-denied",
        cache,
        network,
      )
    }
    if (allowed && !downloadCached) {
      this.requestPersistenceInBackground()
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
      beginDebugLoad("compact")
      const cache = await this.compactEvaluator.getCacheInfo()
      const authorization = await this.authorizeLoad(
        "compact",
        this.compactEvaluator.getStatus(),
        cache,
      )
      if (!authorization.allowed) {
        recordDebugFailure(
          "compact",
          {
            error: new Error(
              authorization.decision === "skip"
                ? "Download skipped while offline and cache is incomplete"
                : "Download consent was not granted",
            ),
          },
          "download-policy",
        )
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
      await this.compactEvaluator.preload(cache, true)
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
    // A foreground wait limit only releases the current quiz. It does not
    // stop the global Quality download, so keep its real loading status and
    // progress visible until that background operation settles.
    if (this.qualityEvaluator.getStatus().phase !== "loading") {
      emitStatus(this.compactEvaluator.getStatus())
    }
  }

  private resetQualityForRetry(generation: number): void {
    if (generation !== this.generation) return
    this.qualityReady = false
    this.qualityDegraded = false
    this.qualityCacheInfoPromise = null
    emitStatus(this.compactEvaluator.getStatus())
  }

  private cancelOrphanedQualityUpgrade(upgrade: Promise<boolean>): void {
    const interests = this.qualityUpgradeInterests.get(upgrade)
    if (
      this.qualityUpgradePromise !== upgrade ||
      (interests?.size ?? 0) > 0
    ) {
      return
    }
    // Once a network load has been authorized, it belongs to the global
    // browser cache rather than to the quiz that initiated it. Leaving that
    // quiz (for example by changing slides) must only stop its foreground
    // evaluation; aborting the shared transfer would throw away useful work.
    if (this.qualityUpgradeContinuesInBackground) return
    this.qualityUpgradeInterests.delete(upgrade)
    this.qualityUpgradeEpoch += 1
    this.qualityUpgradePromise = null
    const controller = this.qualityUpgradeController
    this.qualityUpgradeController = null
    this.qualityCacheInfoPromise = null
    this.qualityReady = false
    this.qualityDegraded = false
    controller?.abort()
    this.qualityEvaluator.cancelPreload?.()
  }

  private retainQualityUpgrade(
    run: EvaluationRun,
    upgrade: Promise<boolean>,
  ): () => void {
    const interests =
      this.qualityUpgradeInterests.get(upgrade) ??
      new Map<EvaluationRun, number>()
    interests.set(
      run,
      (interests.get(run) ?? 0) + 1,
    )
    this.qualityUpgradeInterests.set(upgrade, interests)
    const signals = [...new Set(
      [run.requestSignal, run.lifecycleSignal].filter(
        (signal): signal is AbortSignal => Boolean(signal),
      ),
    )]
    let released = false
    const release = (canceled: boolean): void => {
      if (released) return
      released = true
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort)
      }
      const activeInterests = this.qualityUpgradeInterests.get(upgrade)
      if (!activeInterests) return
      const remaining = (activeInterests.get(run) ?? 1) - 1
      if (remaining > 0) activeInterests.set(run, remaining)
      else activeInterests.delete(run)
      if (activeInterests.size === 0) {
        this.qualityUpgradeInterests.delete(upgrade)
      }
      if (canceled) this.cancelOrphanedQualityUpgrade(upgrade)
    }
    const onAbort = (): void => release(true)
    for (const signal of signals) {
      if (signal.aborted) {
        release(true)
        break
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
    return () => release(false)
  }

  private async waitForQualityUpgradeInForeground(
    upgrade: Promise<boolean>,
    cache: ModelCacheInfo | undefined,
    run: EvaluationRun,
  ): Promise<boolean> {
    const timeoutMs = cache?.cached
      ? this.timings.cachedQualityWaitMs
      : this.timings.uncachedQualityWaitMs
    const result = await waitForRunWithTimeout(upgrade, timeoutMs, run)
    if (!result.timedOut) return result.value

    this.markQualityDegraded(run.generation)
    return false
  }

  private async upgradeQuality(
    generation: number,
    knownCache?: ModelCacheInfo,
    signal?: AbortSignal,
    upgradeEpoch = this.qualityUpgradeEpoch,
  ): Promise<boolean> {
    if (signal?.aborted) throw abortError()
    if (!supportsQualityRuntime()) {
      this.markQualityDegraded(generation)
      return false
    }

    beginDebugLoad("quality")
    const cache = knownCache ?? (await this.getQualityCacheInfo())
    if (signal?.aborted || upgradeEpoch !== this.qualityUpgradeEpoch) {
      throw abortError()
    }
    const authorization = await this.authorizeLoad(
      "quality",
      this.qualityEvaluator.getStatus(),
      cache,
      signal,
    )
    if (signal?.aborted || upgradeEpoch !== this.qualityUpgradeEpoch) {
      throw abortError()
    }
    if (!authorization.allowed || generation !== this.generation) {
      this.markQualityDegraded(generation)
      return false
    }
    if (!cache.cached) {
      this.qualityUpgradeContinuesInBackground = true
    }

    await this.qualityEvaluator.preload(cache, true, signal)
    if (
      signal?.aborted ||
      generation !== this.generation ||
      upgradeEpoch !== this.qualityUpgradeEpoch
    ) {
      return false
    }

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
    const upgradeEpoch = ++this.qualityUpgradeEpoch
    const controller = new AbortController()
    this.qualityUpgradeContinuesInBackground = false
    this.qualityUpgradeController = controller
    const upgrade = this.upgradeQuality(
      generation,
      knownCache,
      controller.signal,
      upgradeEpoch,
    ).catch((error: unknown) => {
      if (
        generation === this.generation &&
        upgradeEpoch === this.qualityUpgradeEpoch
      ) {
        this.qualityCacheInfoPromise = null
        if (isQualityWorkerTimeoutError(error)) {
          this.resetQualityForRetry(generation)
        } else if (isFatalQualityEngineError(error)) {
          this.markQualityDegraded(generation)
        } else {
          this.qualityReady = false
          this.qualityDegraded = false
          emitStatus(this.compactEvaluator.getStatus())
        }
      }
      return false
    })
    let tracked: Promise<boolean>
    tracked = upgrade.finally(() => {
      this.qualityUpgradeInterests.delete(tracked)
      if (this.qualityUpgradePromise === tracked) {
        this.qualityUpgradePromise = null
        this.qualityUpgradeContinuesInBackground = false
        if (this.qualityUpgradeController === controller) {
          this.qualityUpgradeController = null
        }
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
    const languageOnly =
      compactFallback !== undefined &&
      !request.operator?.trim() &&
      !explicitlyRequestsThinking(options) &&
      normalizeLanguageAnalysisOptions(request.languageAnalysis) !== undefined
    const fallback = async (): Promise<EvaluationResult> => {
      assertRunActive(run)
      this.reportProgress(options, run, {
        phase: "fallback-compact",
        engine: "compact",
        message: "Prüfung wird mit dem Kompaktmodell abgeschlossen …",
      })
      if (compactFallback) {
        return qualityUnavailableSafeCompactResult(request, compactFallback)
      }
      return qualityUnavailableSafeCompactResult(
        request,
        await this.evaluateCompact(request, options, run),
      )
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
      const qualityProgress: EvaluationProgress = {
        phase: "evaluating-quality",
        engine: "quality",
        message: languageOnly
          ? "Sprachstatistik wird erstellt …"
          : "Antwort wird gründlich geprüft …",
      }
      if (!languageOnly) {
        qualityProgress.thinkingTimeLimitMs =
          normalizeAdaptiveThinkingLimits(
            options,
            countWords(request.answer),
          ).maxTimeMs
      }
      this.reportProgress(options, run, qualityProgress)
      const linkedSignal = linkRunSignals(run)
      const qualityOptions: EvaluationOptions = {
        ...options,
        signal: linkedSignal.signal,
      }
      if (options?.onProgress) {
        qualityOptions.onProgress = (progress) =>
          this.reportProgress(options, run, progress)
      }
      try {
        if (languageOnly && compactFallback) {
          const languageAnalysis = await waitForRun(
            this.qualityEvaluator.evaluateLanguage(request, qualityOptions),
            run,
          )
          return withLanguageAnalysisFallback(request, {
            ...compactFallback,
            languageAnalysis:
              languageAnalysis ?? compactFallback.languageAnalysis,
          })
        }
        return withLanguageAnalysisFallback(
          request,
          await waitForRun(
            this.qualityEvaluator.evaluate(request, qualityOptions),
            run,
          ),
        )
      } catch (error) {
        if (isAbortError(error)) throw error
        if (
          isQualityOutputError(error) ||
          isRecoverableQualityRequestError(error)
        ) return fallback()
        if (isQualityWorkerTimeoutError(error)) {
          this.resetQualityForRetry(generation)
          return fallback()
        }
        this.markQualityDegraded(generation)
        return fallback()
      } finally {
        linkedSignal.dispose()
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
    await this.ensureCompact()
    if (generation !== this.generation) throw abortError()
    return this.compactEvaluator.getStatus()
  }

  async evaluate(
    originalRequest: EvaluationRequest,
    options?: EvaluationOptions,
  ): Promise<EvaluationResult> {
    const request = snapshotRequest(originalRequest)
    const requestedEngine = requestedAssessmentEngine(request.assessmentEngine)
    const evaluationOptions = options ? { ...options } : undefined
    const normalized = normalizeRequest(request)
    // A newly requested content assessment always takes precedence over an
    // optional language check that was started from an earlier feedback UI.
    this.cancelActiveLanguageEvaluation()
    const deterministicResult = createAssessmentManipulationResult(normalized)
    if (deterministicResult) {
      if (evaluationOptions?.signal?.aborted) throw abortError()
      return deterministicResult
    }
    const exactMatchResult = createExactReferenceMatchResult(normalized)
    if (exactMatchResult) {
      if (evaluationOptions?.signal?.aborted) throw abortError()
      return exactMatchResult
    }
    const advancedQualityFeature =
      normalized.operator !== undefined ||
      normalized.languageAnalysis !== undefined ||
      explicitlyRequestsThinking(evaluationOptions)
    const qualityRequested =
      requestedEngine === "quality" ||
      (requestedEngine === undefined && advancedQualityFeature)
    const implicitLanguageOnly =
      requestedEngine === undefined &&
      normalized.languageAnalysis !== undefined &&
      normalized.operator === undefined &&
      !explicitlyRequestsThinking(evaluationOptions)
    await this.waitForClear()
    const run: EvaluationRun = {
      generation: this.generation,
      requestSignal: evaluationOptions?.signal,
      lifecycleSignal: this.lifecycleController.signal,
    }
    assertRunActive(run)

    this.reportProgress(evaluationOptions, run, {
      phase: "selecting-model",
      engine: requestedEngine !== "compact" && this.qualityReady
        ? "quality"
        : "compact",
      message: "Passendes Modell wird ausgewählt …",
    })

    if (
      requestedEngine === "compact" ||
      (!qualityRequested &&
        (this.qualityDegraded || !supportsQualityRuntime()))
    ) {
      return operatorSafeCompactResult(
        request,
        await this.evaluateCompact(request, evaluationOptions, run),
      )
    }

    let compactResult: EvaluationResult | undefined

    if (
      this.qualityReady &&
      !this.qualityDegraded
    ) {
      return this.evaluateQualityWithFallback(
        request,
        evaluationOptions,
        run,
        compactResult,
      )
    }

    let qualityCache: ModelCacheInfo | undefined
    try {
      const probe = this.getQualityCacheInfo()
      if (qualityRequested) {
        qualityCache = await waitForRun(probe, run)
      } else {
        const result = await waitForRunWithTimeout(
          probe,
          this.timings.qualityCacheProbeWaitMs,
          run,
        )
        if (!result.timedOut) qualityCache = result.value
        // A later quiz/tab may finish downloading Quality before the next check.
        if (!qualityCache?.cached && this.qualityCacheInfoPromise === probe) {
          this.qualityCacheInfoPromise = null
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error
    }
    assertRunActive(run)

    if (this.qualityReady && !this.qualityDegraded) {
      return this.evaluateQualityWithFallback(
        request,
        evaluationOptions,
        run,
        compactResult,
      )
    }

    // Ordinary quizzes reuse Quality locally, without downloading or repairing it.
    if (!qualityRequested && !qualityCache?.cached) {
      return operatorSafeCompactResult(
        request,
        await this.evaluateCompact(request, evaluationOptions, run),
      )
    }

    if (
      qualityCache &&
      qualityPayloadCached(qualityCache) &&
      supportsQualityRuntime() &&
      !this.qualityDegraded
    ) {
      this.reportProgress(evaluationOptions, run, {
        phase: "preparing-quality",
        engine: "quality",
        message: "Qualitätsprüfung wird vorbereitet …",
      })
      const qualityUpgrade = this.startQualityUpgrade(qualityCache)
      const releaseQualityUpgrade = this.retainQualityUpgrade(
        run,
        qualityUpgrade,
      )
      let qualityAvailable: boolean
      try {
        qualityAvailable = await this.waitForQualityUpgradeInForeground(
          qualityUpgrade,
          qualityCache,
          run,
        )
      } finally {
        releaseQualityUpgrade()
      }
      assertRunActive(run)
      if (qualityAvailable) {
        return this.evaluateQualityWithFallback(
          request,
          evaluationOptions,
          run,
          compactResult,
        )
      }
      if (!compactResult) {
        compactResult = operatorSafeCompactResult(
          request,
          await this.evaluateCompact(request, evaluationOptions, run),
        )
      }
      return qualityUnavailableSafeCompactResult(request, compactResult)
    }

    if (implicitLanguageOnly) {
      compactResult = operatorSafeCompactResult(
        request,
        await this.evaluateCompact(request, evaluationOptions, run),
      )
      assertRunActive(run)
    }

    const qualityUpgrade = this.startQualityUpgrade(qualityCache)
    const releaseQualityUpgrade = this.retainQualityUpgrade(
      run,
      qualityUpgrade,
    )
    let qualityAvailable: boolean
    try {
      if (!compactResult) {
        compactResult = operatorSafeCompactResult(
          request,
          await this.evaluateCompact(request, evaluationOptions, run),
        )
        assertRunActive(run)
      }

      this.reportProgress(evaluationOptions, run, {
        phase: "preparing-quality",
        engine: "quality",
        message: "Qualitätsprüfung wird vorbereitet …",
      })
      qualityAvailable = await this.waitForQualityUpgradeInForeground(
        qualityUpgrade,
        qualityCache,
        run,
      )
    } finally {
      releaseQualityUpgrade()
    }
    assertRunActive(run)
    if (!qualityAvailable || run.generation !== this.generation) {
      return qualityUnavailableSafeCompactResult(request, compactResult)
    }
    return this.evaluateQualityWithFallback(
      request,
      evaluationOptions,
      run,
      compactResult,
    )
  }

  async evaluateLanguage(
    originalRequest: EvaluationRequest,
    options?: EvaluationOptions,
  ): Promise<LanguageAnalysisResult | undefined> {
    const request = snapshotRequest(originalRequest)
    const normalized = normalizeRequest(request)
    const languageOptions = normalized.languageAnalysis
    if (!languageOptions) return undefined

    this.cancelActiveLanguageEvaluation()
    const controller = new AbortController()
    const callerSignal = options?.signal
    const abortFromCaller = (): void => controller.abort()
    if (callerSignal?.aborted) controller.abort()
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true })
    this.activeLanguageController = controller

    try {
      await this.waitForClear()
      const run: EvaluationRun = {
        generation: this.generation,
        requestSignal: controller.signal,
        lifecycleSignal: this.lifecycleController.signal,
      }
      assertRunActive(run)
      this.reportProgress(options, run, {
        phase: "selecting-model",
        engine: "quality",
        message: "Sprachmodell wird ausgewählt …",
      })
      if (!this.qualityReady || this.qualityDegraded) {
        let cache: ModelCacheInfo | undefined
        try {
          cache = await waitForRun(this.getQualityCacheInfo(), run)
        } catch (error) {
          if (isAbortError(error)) throw error
        }
        assertRunActive(run)
        if (!this.qualityDegraded) {
          this.reportProgress(options, run, {
            phase: "preparing-quality",
            engine: "quality",
            message: "Sprachprüfung wird vorbereitet …",
          })
          const qualityUpgrade = this.startQualityUpgrade(cache)
          const releaseQualityUpgrade = this.retainQualityUpgrade(
            run,
            qualityUpgrade,
          )
          let available: boolean
          try {
            available = await waitForRun(
              qualityUpgrade,
              run,
            )
          } finally {
            releaseQualityUpgrade()
          }
          if (!available) {
            return unavailableLanguageAnalysis(
              normalized.answer,
              languageOptions,
            )
          }
        }
      }
      assertRunActive(run)
      if (!this.qualityReady || this.qualityDegraded) {
        return unavailableLanguageAnalysis(normalized.answer, languageOptions)
      }
      this.reportProgress(options, run, {
        phase: "evaluating-quality",
        engine: "quality",
        message: languageOptions.spelling && languageOptions.syntax
          ? "Rechtschreibung, Zeichensetzung, Grammatik und Satzbau werden geprüft …"
          : languageOptions.spelling
            ? "Rechtschreibung und Zeichensetzung werden geprüft …"
            : "Grammatik und Satzbau werden geprüft …",
      })

      const generation = run.generation
      const task = async (): Promise<LanguageAnalysisResult> => {
        assertRunActive(run)
        if (
          generation !== this.generation ||
          !this.qualityReady ||
          this.qualityDegraded
        ) {
          return unavailableLanguageAnalysis(
            normalized.answer,
            languageOptions,
          )
        }
        const linkedSignal = linkRunSignals(run)
        const languageEvaluationOptions: EvaluationOptions = {
          ...options,
          signal: linkedSignal.signal,
        }
        if (options?.onProgress) {
          languageEvaluationOptions.onProgress = (progress) =>
            this.reportProgress(options, run, progress)
        }
        try {
          return (
            (await waitForRun(
              this.qualityEvaluator.evaluateLanguage(
                request,
                languageEvaluationOptions,
              ),
              run,
            )) ??
            unavailableLanguageAnalysis(normalized.answer, languageOptions)
          )
        } catch (error) {
          if (isAbortError(error)) throw error
          if (isQualityWorkerTimeoutError(error)) {
            this.resetQualityForRetry(generation)
          } else if (isFatalQualityEngineError(error)) {
            this.markQualityDegraded(generation)
          }
          return unavailableLanguageAnalysis(
            normalized.answer,
            languageOptions,
          )
        } finally {
          linkedSignal.dispose()
        }
      }
      const evaluation = this.qualityEvaluationQueue.then(task, task)
      this.qualityEvaluationQueue = evaluation.then(
        () => undefined,
        () => undefined,
      )
      return await waitForRun(evaluation, run)
    } finally {
      callerSignal?.removeEventListener("abort", abortFromCaller)
      if (this.activeLanguageController === controller) {
        this.activeLanguageController = null
      }
    }
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
    this.cancelActiveLanguageEvaluation()
    this.lifecycleController.abort()
    this.lifecycleController = new AbortController()
    this.qualityUpgradeEpoch += 1
    this.qualityUpgradeController?.abort()
    this.qualityUpgradeController = null
    this.qualityUpgradeContinuesInBackground = false
    this.qualityUpgradeInterests.clear()
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
