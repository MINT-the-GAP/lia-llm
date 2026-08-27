import {
  LARGE_QUALITY_MODEL,
  SMALL_QUALITY_MODEL,
} from "./quality-model-config.ts"

export const STORAGE_ESTIMATE_TIMEOUT_MS = 5_000
export const STORAGE_SAFETY_RESERVE_BYTES = 512 * 1024 * 1024
export const STORAGE_SAFETY_RESERVE_RATIO = 0.1

export type SelectableQualityModel =
  | typeof SMALL_QUALITY_MODEL
  | typeof LARGE_QUALITY_MODEL

/** Minimal, injectable equivalent of the browser's StorageEstimate. */
export interface StorageEstimateLike {
  readonly quota?: number
  readonly usage?: number
}

/** Minimal, injectable equivalent of navigator.storage. */
export interface StorageEstimateSource {
  estimate(): Promise<StorageEstimateLike>
}

export interface KnownStorageAvailability {
  readonly kind: "known"
  readonly quotaBytes: number
  readonly usageBytes: number
  /** Bytes not currently occupied, before applying the safety reserve. */
  readonly availableBytes: number
  readonly safetyReserveBytes: number
  /** Bytes that may safely be used for a new model download. */
  readonly usableBytes: number
}

export type UnknownStorageReason =
  | "unsupported"
  | "timeout"
  | "error"
  | "invalid"

export interface UnknownStorageAvailability {
  readonly kind: "unknown"
  readonly reason: UnknownStorageReason
}

export type StorageAvailability =
  | KnownStorageAvailability
  | UnknownStorageAvailability

export interface StorageEstimateOptions {
  /**
   * An explicit source makes this function independent of navigator in tests.
   * Passing null deliberately represents an unsupported browser.
   */
  readonly source?: StorageEstimateSource | null
  /** Values above five seconds are capped to keep startup bounded. */
  readonly timeoutMs?: number
}

export interface QualityModelCacheState {
  /** The complete model and its required runtime metadata are cached. */
  readonly cached?: boolean
  /** The large model payload is cached; small metadata may still be missing. */
  readonly payloadCached?: boolean
}

export interface QualityModelCaches {
  readonly small?: QualityModelCacheState
  readonly large?: QualityModelCacheState
}

export interface QualityModelSelectionInput {
  readonly storage: StorageAvailability
  readonly cache?: QualityModelCaches
}

export type QualityModelSelectionReason =
  | "large-cached"
  | "large-payload-cached"
  | "large-fits"
  | "large-fits-after-small-removal"
  | "small-cached"
  | "small-payload-cached"
  | "small-fits"
  | "estimate-unavailable"
  | "insufficient-storage"

export interface QualityModelSelectionDecision {
  readonly model: SelectableQualityModel
  readonly sufficient: boolean
  readonly reason: QualityModelSelectionReason
  readonly payloadCached: boolean
  /** Cached model that may be removed only after download consent. */
  readonly replacedModel?: SelectableQualityModel
  readonly storage: StorageAvailability
}

export interface EstimateAndSelectQualityModelOptions
  extends StorageEstimateOptions {
  readonly cache?: QualityModelCaches
}

function browserStorageEstimateSource(): StorageEstimateSource | undefined {
  if (typeof navigator === "undefined") return undefined

  const storage = (
    navigator as Navigator & {
      storage?: { estimate?: () => Promise<StorageEstimateLike> }
    }
  ).storage
  if (!storage || typeof storage.estimate !== "function") return undefined

  // Keep the browser StorageManager as `this`; some platform methods require it.
  return { estimate: () => storage.estimate!() }
}

function boundedTimeoutMs(timeoutMs: number | undefined): number {
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    return STORAGE_ESTIMATE_TIMEOUT_MS
  }
  return Math.min(timeoutMs, STORAGE_ESTIMATE_TIMEOUT_MS)
}

function validByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * Validates a raw StorageEstimate and derives capacity after the mandatory
 * reserve. Invalid or internally inconsistent browser values stay unknown.
 */
export function storageAvailabilityFromEstimate(
  estimate: unknown,
): StorageAvailability {
  if (typeof estimate !== "object" || estimate === null) {
    return { kind: "unknown", reason: "invalid" }
  }

  const candidate = estimate as StorageEstimateLike
  if (
    !validByteCount(candidate.quota) ||
    !validByteCount(candidate.usage) ||
    candidate.usage > candidate.quota
  ) {
    return { kind: "unknown", reason: "invalid" }
  }

  const availableBytes = candidate.quota - candidate.usage
  const safetyReserveBytes = Math.max(
    STORAGE_SAFETY_RESERVE_BYTES,
    candidate.quota * STORAGE_SAFETY_RESERVE_RATIO,
  )

  return {
    kind: "known",
    quotaBytes: candidate.quota,
    usageBytes: candidate.usage,
    availableBytes,
    safetyReserveBytes,
    usableBytes: Math.max(0, availableBytes - safetyReserveBytes),
  }
}

/**
 * Reads navigator.storage.estimate() with feature detection and a hard timeout.
 * Errors are represented as data so a failed browser API cannot block startup.
 */
export async function estimateStorageAvailability(
  options: StorageEstimateOptions = {},
): Promise<StorageAvailability> {
  const source =
    options.source === undefined
      ? browserStorageEstimateSource()
      : options.source ?? undefined
  if (!source || typeof source.estimate !== "function") {
    return { kind: "unknown", reason: "unsupported" }
  }

  type EstimateOutcome =
    | { readonly kind: "value"; readonly value: StorageEstimateLike }
    | { readonly kind: "error" }
    | { readonly kind: "timeout" }

  const operation = Promise.resolve()
    .then(() => source.estimate())
    .then<EstimateOutcome, EstimateOutcome>(
      (value) => ({ kind: "value", value }),
      () => ({ kind: "error" }),
    )

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<EstimateOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timeout" }),
      boundedTimeoutMs(options.timeoutMs),
    )
  })

  let outcome: EstimateOutcome
  try {
    outcome = await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  if (outcome.kind === "timeout") {
    return { kind: "unknown", reason: "timeout" }
  }
  if (outcome.kind === "error") {
    return { kind: "unknown", reason: "error" }
  }
  return storageAvailabilityFromEstimate(outcome.value)
}

function payloadIsCached(cache: QualityModelCacheState | undefined): boolean {
  return cache?.cached === true || cache?.payloadCached === true
}

function modelIsFullyCached(
  cache: QualityModelCacheState | undefined,
): boolean {
  return cache?.cached === true
}

function modelFits(
  model: SelectableQualityModel,
  storage: StorageAvailability,
  reclaimableBytes = 0,
): boolean {
  return (
    storage.kind === "known" &&
    model.estimatedBytes <= storage.usableBytes + reclaimableBytes
  )
}

function decision(
  model: SelectableQualityModel,
  sufficient: boolean,
  reason: QualityModelSelectionReason,
  payloadCached: boolean,
  storage: StorageAvailability,
  replacedModel?: SelectableQualityModel,
): QualityModelSelectionDecision {
  return {
    model,
    sufficient,
    reason,
    payloadCached,
    storage,
    replacedModel,
  }
}

/**
 * Selects the best viable model. Cached payloads take priority over estimates;
 * without a usable estimate the smaller model is the conservative fallback.
 */
export function selectQualityModel(
  input: QualityModelSelectionInput,
): QualityModelSelectionDecision {
  const largeFullyCached = modelIsFullyCached(input.cache?.large)
  const smallFullyCached = modelIsFullyCached(input.cache?.small)
  const largePayloadCached = payloadIsCached(input.cache?.large)
  const smallPayloadCached = payloadIsCached(input.cache?.small)
  if (largeFullyCached) {
    return decision(
      LARGE_QUALITY_MODEL,
      true,
      "large-cached",
      true,
      input.storage,
    )
  }
  if (modelFits(LARGE_QUALITY_MODEL, input.storage)) {
    return decision(
      LARGE_QUALITY_MODEL,
      true,
      "large-fits",
      largePayloadCached,
      input.storage,
    )
  }

  if (
    smallPayloadCached &&
    modelFits(
      LARGE_QUALITY_MODEL,
      input.storage,
      SMALL_QUALITY_MODEL.estimatedBytes,
    )
  ) {
    return decision(
      LARGE_QUALITY_MODEL,
      true,
      "large-fits-after-small-removal",
      largePayloadCached,
      input.storage,
      SMALL_QUALITY_MODEL,
    )
  }

  if (smallFullyCached) {
    return decision(
      SMALL_QUALITY_MODEL,
      true,
      "small-cached",
      true,
      input.storage,
    )
  }
  if (largePayloadCached) {
    return decision(
      LARGE_QUALITY_MODEL,
      true,
      "large-payload-cached",
      true,
      input.storage,
    )
  }
  if (smallPayloadCached) {
    return decision(
      SMALL_QUALITY_MODEL,
      true,
      "small-payload-cached",
      true,
      input.storage,
    )
  }
  if (modelFits(SMALL_QUALITY_MODEL, input.storage)) {
    return decision(
      SMALL_QUALITY_MODEL,
      true,
      "small-fits",
      false,
      input.storage,
    )
  }

  if (input.storage.kind === "unknown") {
    return decision(
      SMALL_QUALITY_MODEL,
      true,
      "estimate-unavailable",
      false,
      input.storage,
    )
  }

  return decision(
    SMALL_QUALITY_MODEL,
    false,
    "insufficient-storage",
    false,
    input.storage,
  )
}

/** Convenience composition for production callers; tests can exercise both halves. */
export async function estimateAndSelectQualityModel(
  options: EstimateAndSelectQualityModelOptions = {},
): Promise<QualityModelSelectionDecision> {
  const storage = await estimateStorageAvailability({
    source: options.source,
    timeoutMs: options.timeoutMs,
  })
  return selectQualityModel({ storage, cache: options.cache })
}
