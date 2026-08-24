import type {
  AssessmentEngine,
  DebugEnvironment,
  DebugFinding,
  DebugReportOptions,
  DebugReportTrigger,
  DebugStorageSummary,
  DebugTraceEvent,
  LiaLLMApi,
  LiaLLMDebugReport,
  ModelCacheInfo,
  RuntimeStatus,
} from "./types.ts"

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

interface DiagnosticsApi {
  version: string
  getStatus(): RuntimeStatus
  getCacheInfo(): Promise<ModelCacheInfo>
}

interface DiagnosticState {
  startedAt: number
  sequence: number
  runSequence: number
  currentRuns: Partial<Record<AssessmentEngine, string>>
  events: DebugTraceEvent[]
  activities: Map<string, DebugTraceEvent>
  cacheSnapshots: Partial<Record<AssessmentEngine, ModelCacheInfo>>
  latestStatuses: Partial<Record<AssessmentEngine, RuntimeStatus>>
  lastErrors: Partial<
    Record<AssessmentEngine, AutomaticReportSnapshot & { sequence: number }>
  >
  api: DiagnosticsApi | null
  registered: boolean
  printed: Set<string>
  checkedReadyRuns: Set<string>
}

interface AutomaticReportSnapshot {
  engine: AssessmentEngine
  runId: string
  status: RuntimeStatus | null
}

const STATE_KEY = Symbol.for("MINT-the-GAP.lia-llm.debug-diagnostics.v1")
const MAX_EVENTS = 70
const MAX_TEXT_LENGTH = 700
const STORAGE_PROBE_TIMEOUT_MS = 5_000

function clockMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now()
}

function createState(): DiagnosticState {
  return {
    startedAt: clockMs(),
    sequence: 0,
    runSequence: 0,
    currentRuns: {},
    events: [],
    activities: new Map(),
    cacheSnapshots: {},
    latestStatuses: {},
    lastErrors: {},
    api: null,
    registered: false,
    printed: new Set(),
    checkedReadyRuns: new Set(),
  }
}

function diagnosticState(): DiagnosticState {
  const root = globalThis as typeof globalThis & Record<symbol, unknown>
  const existing = root[STATE_KEY]
  if (existing) return existing as DiagnosticState
  const created = createState()
  root[STATE_KEY] = created
  return created
}

function elapsedMs(): number {
  return Math.max(0, Math.round(clockMs() - diagnosticState().startedAt))
}

function sanitizeUrl(value: string): { host: string; artifact: string } {
  try {
    const url = new URL(value)
    const rawName = url.pathname.split("/").filter(Boolean).pop() ?? ""
    const artifact = rawName
      .replace(/^[a-f\d]{40,}$/iu, (hash) => `${hash.slice(0, 12)}…`)
      .slice(0, 160)
    return { host: url.host.slice(0, 160), artifact: artifact || "(ohne Dateiname)" }
  } catch {
    return { host: "(unbekannt)", artifact: "(ungültige URL)" }
  }
}

function sanitizedUrlText(value: string): string {
  const { host, artifact } = sanitizeUrl(value)
  return host === "(unbekannt)" ? artifact : `https://${host}/…/${artifact}`
}

export function sanitizeDebugText(value: unknown): string {
  const source = String(value ?? "")
    .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => sanitizedUrlText(url))
    .replace(/Bearer\s+[A-Za-z\d._~+/=-]+/giu, "Bearer <redacted>")
    .replace(
      /([?&](?:access_token|auth|key|signature|token)=)[^\s&#]+/giu,
      "$1<redacted>",
    )
    .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => sanitizedUrlText(url))
  return source.length > MAX_TEXT_LENGTH
    ? `${source.slice(0, MAX_TEXT_LENGTH)}…`
    : source
}

const GENERIC_ERROR_NAME = "Error"
const GENERIC_ERROR_MESSAGE = "Nicht klassifizierter technischer Fehler."

const ALLOWED_ERROR_NAMES = new Map<string, string>([
  ["error", "Error"],
  ["typeerror", "TypeError"],
  ["rangeerror", "RangeError"],
  ["aborterror", "AbortError"],
  ["timeouterror", "TimeoutError"],
  ["quotaexceedederror", "QuotaExceededError"],
  ["securityerror", "SecurityError"],
  ["notallowederror", "NotAllowedError"],
  ["invalidstateerror", "InvalidStateError"],
  ["networkerror", "NetworkError"],
  ["operationerror", "OperationError"],
  ["dataerror", "DataError"],
  ["compileerror", "CompileError"],
  ["linkerror", "LinkError"],
  ["contextwindowsizeexceedederror", "ContextWindowSizeExceededError"],
])

function rawDebugString(value: unknown): string {
  try {
    return String(value ?? "")
  } catch {
    return ""
  }
}

function canonicalErrorSignature(
  errorName: unknown,
  errorMessage: unknown,
): { name: string; message: string } {
  const rawName = rawDebugString(errorName).trim()
  const rawMessage = rawDebugString(errorMessage)
  const haystack = rawName + " " + rawMessage

  const orthographyFailure = haystack.match(
    /Orthography correction validation failed \(([-a-z]+)\)/iu,
  )?.[1]
  if (orthographyFailure) {
    return {
      name: "DataError",
      message:
        "Orthography correction validation failed (" +
        orthographyFailure +
        ").",
    }
  }

  if (
    rawName.toLowerCase() === "aborterror" ||
    /\bAbortError\b|\b(?:operation|vorgang|download|request|anfrage)\s+(?:was\s+)?(?:aborted|cancelled|canceled|abgebrochen)\b/iu
      .test(haystack)
  ) {
    return {
      name: "AbortError",
      message: "Der technische Vorgang wurde abgebrochen (AbortError).",
    }
  }
  if (
    /ContextWindow(?:SizeExceeded)?Error|Kontextfenster|prompt tokens exceed context window size|context(?:-|\s*)window[^.\n]{0,80}(?:exceed|limit|too (?:large|long)|overflow)/iu
      .test(haystack)
  ) {
    return {
      name: "ContextWindowSizeExceededError",
      message: "Das Kontextfenster wurde ueberschritten (ContextWindowError).",
    }
  }
  if (
    /QuotaExceededError|quota(?:\s+exceeded)?|storage\s+(?:is\s+)?full|disk\s+(?:is\s+)?full|Speicher(?:platz)?(?:limit)?[^.\n]{0,80}\b(?:voll|erschoepft|erschöpft|ueberschritten|überschritten)/iu
      .test(haystack)
  ) {
    return {
      name: "QuotaExceededError",
      message: "Die Speicherquote wurde ueberschritten (QuotaExceededError).",
    }
  }
  if (/NotAllowedError/iu.test(haystack)) {
    return {
      name: "NotAllowedError",
      message: "Der technische Zugriff wurde nicht erlaubt (NotAllowedError).",
    }
  }
  if (/SecurityError/iu.test(haystack)) {
    return {
      name: "SecurityError",
      message: "Der technische Zugriff wurde verweigert (SecurityError).",
    }
  }
  if (/InvalidStateError/iu.test(haystack)) {
    return {
      name: "InvalidStateError",
      message: "Der technische Vorgang ist in diesem Zustand nicht erlaubt (InvalidStateError).",
    }
  }
  if (
    /Content-Range|Byte-?Bereich|Byte-Download unerwartet beendet|Range-(?:Anfrage|Antwort)|HTTP 200 statt|bereits geladenen Bytes|Prefix/iu
      .test(haystack)
  ) {
    return {
      name: "NetworkError",
      message: "Die Byte-Range- oder Content-Range-Antwort war ungueltig.",
    }
  }
  if (
    /TimeoutError|timed?\s*out|timeout|Zeit[^.\n]{0,40}(?:abgelaufen|ueberschritten|überschritten)|keine neuen Daten/iu
      .test(haystack)
  ) {
    return {
      name: "TimeoutError",
      message: "Der technische Vorgang endete wegen einer Zeitueberschreitung (TimeoutError).",
    }
  }
  if (
    /zu wenig|unvollst|truncat|frueh[^.\n]{0,30}beendet|früh[^.\n]{0,30}beendet|vorzeitig|Leere (?:Voll-)?Download-Antwort/iu
      .test(haystack)
  ) {
    return {
      name: "NetworkError",
      message: "Der Download war unvollstaendig oder vorzeitig beendet (truncated).",
    }
  }
  if (/zu viele|size mismatch|Groesse|Größe|statt\s+\d+\s+Bytes/iu.test(haystack)) {
    return {
      name: "NetworkError",
      message: "Die empfangene Dateigroesse stimmt nicht (size mismatch).",
    }
  }
  if (
    /integrity|sha-?256|hash mismatch|corrupt|kein gueltiges|kein gültiges|ungueltiges[^.\n]{0,30}Artefakt|ungültiges[^.\n]{0,30}Artefakt/iu
      .test(haystack)
  ) {
    return {
      name: "DataError",
      message: "Die Integritaetspruefung des Artefakts ist fehlgeschlagen (integrity).",
    }
  }
  const dxgi = haystack.match(
    /DXGI_ERROR_DEVICE_(HUNG|REMOVED|RESET)/iu,
  )?.[1]?.toUpperCase()
  if (dxgi) {
    return {
      name: "OperationError",
      message: "WebGPU device lost (DXGI_ERROR_DEVICE_" + dxgi + ").",
    }
  }
  if (/VK_ERROR_DEVICE_LOST/iu.test(haystack)) {
    return {
      name: "OperationError",
      message: "WebGPU device lost (VK_ERROR_DEVICE_LOST).",
    }
  }
  if (/object has already been disposed|tensor has already been disposed|cannot pass deleted object/iu.test(haystack)) {
    return {
      name: "OperationError",
      message: "Ein WebGPU-Objekt wurde bereits freigegeben (object disposed).",
    }
  }
  if (/out of (?:gpu )?memory|\boom\b|memory allocation/iu.test(haystack)) {
    return {
      name: "OperationError",
      message: "WebGPU hat nicht genug Geraetespeicher (out of memory).",
    }
  }
  if (/WebGPU|requestAdapter|requestDevice|device[-_ ]?(?:was )?lost|gpu[^.\n]{0,40}(?:hang|lost)/iu.test(haystack)) {
    return {
      name: "OperationError",
      message: "Die WebGPU-Laufzeit oder das GPU-Geraet ist ausgefallen (device lost).",
    }
  }
  if (/Content Security Policy|Refused to|wasm-unsafe-eval|unsafe-eval|script-src|worker-src/iu.test(haystack)) {
    return {
      name: "SecurityError",
      message: "Die Content Security Policy blockiert eine benoetigte Laufzeitfunktion.",
    }
  }
  if (/ONNX|WASM|WebAssembly|InferenceSession|execution provider|backend|instantiate|CompileError|LinkError/iu.test(haystack)) {
    return {
      name: /CompileError/iu.test(haystack)
        ? "CompileError"
        : /LinkError/iu.test(haystack)
          ? "LinkError"
          : "OperationError",
      message: "Die ONNX- oder WebAssembly-Laufzeit konnte nicht initialisiert werden.",
    }
  }
  if (
    /Orthografi|Korrektureintrag|Quelltext|Spaltenposition|Zeilenposition|Wortersatz|Wortgrenzen|nderungskategorien/iu
      .test(haystack)
  ) {
    const reason =
      /Quelltext/iu.test(haystack)
        ? "anchor-mismatch"
        : /Spaltenposition|Zeilenposition/iu.test(haystack)
          ? "position-invalid"
          : /Zahl der|nderungskategorien/iu.test(haystack)
            ? "count-mismatch"
            : /Wortersatz|Wortgrenzen|Wort ersetzen/iu.test(haystack)
              ? "unsafe-spelling-edit"
              : /sortiert|berlapp/iu.test(haystack)
                ? "overlapping-edits"
                : "invalid-output"
    return {
      name: "DataError",
      message: "Orthography correction validation failed (" + reason + ").",
    }
  }
  const httpStatus = haystack.match(
    /\bHTTP(?:\s+status)?\s*[:=]?\s*([1-5]\d{2})\b/iu,
  )?.[1]
  if (httpStatus) {
    return {
      name: "NetworkError",
      message: "HTTP " + httpStatus + ".",
    }
  }
  if (/Failed to fetch|NetworkError|Load failed|network request failed|fetch failed/iu.test(haystack)) {
    return {
      name: rawName.toLowerCase() === "typeerror" ? "TypeError" : "NetworkError",
      message: "Der Netzwerkabruf ist fehlgeschlagen (Failed to fetch).",
    }
  }

  return {
    name: ALLOWED_ERROR_NAMES.get(rawName.toLowerCase()) ?? GENERIC_ERROR_NAME,
    message: GENERIC_ERROR_MESSAGE,
  }
}

function normalizedError(error: unknown): { name: string; message: string } {
  if (error !== null && typeof error === "object") {
    let name: unknown = GENERIC_ERROR_NAME
    let message: unknown = ""
    try {
      name = (error as { name?: unknown }).name ?? GENERIC_ERROR_NAME
    } catch {
      // Accessor-backed foreign errors can throw while being inspected.
    }
    try {
      message = (error as { message?: unknown }).message ?? ""
    } catch {
      // Never serialize the object itself if its message cannot be inspected.
    }
    return canonicalErrorSignature(name, message)
  }
  return canonicalErrorSignature(GENERIC_ERROR_NAME, error)
}

function canonicalizeDebugEvent(event: DebugTraceEvent): DebugTraceEvent {
  if (event.errorName === undefined && event.message === undefined) return event
  const error = canonicalErrorSignature(event.errorName, event.message)
  return { ...event, errorName: error.name, message: error.message }
}

function appendEvent(
  event: Omit<DebugTraceEvent, "sequence" | "elapsedMs">,
): DebugTraceEvent {
  const state = diagnosticState()
  const complete = canonicalizeDebugEvent({
    ...event,
    sequence: ++state.sequence,
    elapsedMs: elapsedMs(),
  })
  state.events.push(complete)
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS)
  }
  return complete
}

function runIdFor(engine: AssessmentEngine): string {
  const state = diagnosticState()
  return state.currentRuns[engine] ?? `${engine}-untracked`
}

export function beginDebugLoad(engine: AssessmentEngine): string {
  const state = diagnosticState()
  delete state.lastErrors[engine]
  delete state.latestStatuses[engine]
  delete state.cacheSnapshots[engine]
  state.events = state.events.filter((event) => event.engine !== engine)
  for (const key of state.activities.keys()) {
    if (key.startsWith(engine + ":")) state.activities.delete(key)
  }
  const runId = `${engine}-${++state.runSequence}`
  state.currentRuns[engine] = runId
  appendEvent({ kind: "load-start", engine, runId, outcome: "started" })
  return runId
}

export function recordDebugPolicy(
  engine: AssessmentEngine,
  decision: string,
  cache: ModelCacheInfo,
  network: { online: boolean; saveData: boolean; connectionType: string | null },
): void {
  diagnosticState().cacheSnapshots[engine] = sanitizeCacheInfo(cache)
  appendEvent({
    kind: "policy",
    engine,
    runId: runIdFor(engine),
    outcome: decision,
    details: {
      online: network.online,
      saveData: network.saveData,
      connectionType: network.connectionType,
      cached: cache.cached,
      downloadCached: cache.downloadCached ?? cache.cached,
      filesCached: cache.filesCached,
      filesTotal: cache.filesTotal,
    },
  })
}

export function recordDebugPersistence(
  outcome: "granted" | "denied" | "error",
  error?: unknown,
): void {
  const normalized = error === undefined ? null : normalizedError(error)
  appendEvent({
    kind: "persistence",
    stage: "navigator.storage.persist",
    outcome,
    errorName: normalized?.name,
    message: normalized?.message,
  })
}

export function recordDebugCache(
  engine: AssessmentEngine,
  operation: string,
  outcome: string,
  options: {
    cacheName?: string
    url?: string
    error?: unknown
    details?: Record<string, string | number | boolean | null>
  } = {},
): void {
  const target = options.url ? sanitizeUrl(options.url) : null
  const normalized = options.error === undefined
    ? null
    : normalizedError(options.error)
  appendEvent({
    kind: "cache",
    engine,
    runId: runIdFor(engine),
    stage: operation,
    host: target?.host,
    artifact: target?.artifact ?? options.cacheName?.slice(0, 160),
    outcome,
    errorName: normalized?.name,
    message: normalized?.message,
    details: options.details,
  })
}

export function recordDebugActivity(
  engine: AssessmentEngine,
  activity: { url: string; loaded: number; total?: number },
): void {
  const target = sanitizeUrl(activity.url)
  diagnosticState().activities.set(`${engine}:${target.host}:${target.artifact}`, {
    sequence: 0,
    elapsedMs: elapsedMs(),
    kind: "fetch-activity",
    engine,
    runId: runIdFor(engine),
    host: target.host,
    artifact: target.artifact,
    loaded: activity.loaded,
    expected: activity.total,
    outcome:
      activity.total !== undefined && activity.loaded >= activity.total
        ? "complete"
        : "receiving",
  })
}

export function recordDebugRetry(
  engine: AssessmentEngine,
  retry: { url: string; attempt: number; error: unknown },
): void {
  const target = sanitizeUrl(retry.url)
  const error = normalizedError(retry.error)
  appendEvent({
    kind: "fetch-retry",
    engine,
    runId: runIdFor(engine),
    host: target.host,
    artifact: target.artifact,
    attempt: retry.attempt,
    outcome: "retry",
    errorName: error.name,
    message: error.message,
  })
}

export function recordDebugFailure(
  engine: AssessmentEngine,
  failure: { url?: string; expectedBytes?: number; error: unknown },
  stage = "download",
): void {
  const target = failure.url ? sanitizeUrl(failure.url) : null
  const error = normalizedError(failure.error)
  appendEvent({
    kind: "failure",
    engine,
    runId: runIdFor(engine),
    stage,
    host: target?.host,
    artifact: target?.artifact,
    expected: failure.expectedBytes,
    outcome: "failed",
    errorName: error.name,
    message: error.message,
  })
  if (stage === "download-policy") {
    scheduleAutomaticReport("load-error", engine)
  }
}

export function recordDebugLanguageAnalysisFailure(
  engine: AssessmentEngine,
  failure: {
    attempts: number
    reason: "incomplete-output" | "invalid-output" | "request-error"
    finishReason: "stop" | "length" | "other" | "missing"
  },
): void {
  appendEvent({
    kind: "language-analysis",
    engine,
    runId: runIdFor(engine),
    stage: "output-validation",
    outcome: "unavailable",
    details: {
      attempts: failure.attempts,
      reason: failure.reason,
      finishReason: failure.finishReason,
    },
  })
}

export function recordDebugLanguageAnalysisCompleted(
  engine: AssessmentEngine,
  attempts: number,
): void {
  appendEvent({
    kind: "language-analysis",
    engine,
    runId: runIdFor(engine),
    stage: "output-validation",
    outcome: "completed",
    details: { attempts },
  })
}

export function instrumentDebugFetch(
  engine: AssessmentEngine,
  baseFetch: FetchLike,
): FetchLike {
  const runId = runIdFor(engine)
  return async (input, init) => {
    const started = clockMs()
    let request: Request
    try {
      request = new Request(input, init)
    } catch (error) {
      recordDebugFailure(engine, { error }, "request")
      throw error
    }
    const target = sanitizeUrl(request.url)
    const range = request.headers.get("range")
    appendEvent({
      kind: "fetch-start",
      engine,
      runId,
      host: target.host,
      artifact: target.artifact,
      method: request.method,
      transport: range ? "range" : "direct",
      details: { range },
    })
    try {
      const response = await baseFetch(request)
      const responseTarget = sanitizeUrl(response.url || request.url)
      const contentLength = response.headers.get("content-length")
      const contentRange = response.headers.get("content-range")
      const contentEncoding = response.headers.get("content-encoding")
      appendEvent({
        kind: "fetch-response",
        engine,
        runId,
        host: responseTarget.host,
        artifact: responseTarget.artifact,
        method: request.method,
        transport: range ? "range" : "direct",
        httpStatus: response.status,
        durationMs: Math.max(0, Math.round(clockMs() - started)),
        outcome: response.ok ? "ok" : "http-error",
        details: {
          range,
          requestedHost: target.host,
          requestedArtifact: target.artifact,
          redirected: response.redirected,
          responseType: response.type,
          contentLength,
          contentRange,
          contentEncoding,
          contentType: response.headers.get("content-type"),
        },
      })
      return response
    } catch (error) {
      const normalized = normalizedError(error)
      appendEvent({
        kind: "fetch-attempt-error",
        engine,
        runId,
        stage: "fetch",
        host: target.host,
        artifact: target.artifact,
        method: request.method,
        transport: range ? "range" : "direct",
        durationMs: Math.max(0, Math.round(clockMs() - started)),
        outcome: "fetch-rejected",
        errorName: normalized.name,
        message: normalized.message,
        details: { range },
      })
      throw error
    }
  }
}

function sanitizeCacheInfo(cache: ModelCacheInfo): ModelCacheInfo {
  const engines = cache.engines
    ? {
        ...(cache.engines.compact
          ? { compact: sanitizeCacheInfo(cache.engines.compact) }
          : {}),
        ...(cache.engines.quality
          ? { quality: sanitizeCacheInfo(cache.engines.quality) }
          : {}),
      }
    : undefined
  return {
    supported: Boolean(cache.supported),
    cached: Boolean(cache.cached),
    downloadCached: Boolean(cache.downloadCached ?? cache.cached),
    filesCached: Number.isFinite(cache.filesCached) ? cache.filesCached : 0,
    filesTotal: Number.isFinite(cache.filesTotal) ? cache.filesTotal : 0,
    estimatedBytes: Number.isFinite(cache.estimatedBytes)
      ? cache.estimatedBytes
      : 0,
    persistent: cache.persistent,
    engines,
    error: cache.error
      ? canonicalErrorSignature(GENERIC_ERROR_NAME, cache.error).message
      : undefined,
  }
}

function canonicalStorageError(value: unknown): string {
  const raw = rawDebugString(value)
  const labels = [
    ["Cachepr\u00fcfung", /Cachepr(?:\u00fc|ue)fung/iu],
    ["Persistenzpr\u00fcfung", /Persistenzpr(?:\u00fc|ue)fung/iu],
    ["Speicherquotenpr\u00fcfung", /Speicherquotenpr(?:\u00fc|ue)fung/iu],
    ["StorageManager", /StorageManager/iu],
  ] as const
  const safeLabels = labels
    .filter(([, pattern]) => pattern.test(raw))
    .map(([label]) => label)
  const error = canonicalErrorSignature(GENERIC_ERROR_NAME, raw).message
  return safeLabels.length ? safeLabels.join("; ") + ": " + error : error
}

function sanitizeStorageSummary(
  storage: DebugStorageSummary,
): DebugStorageSummary {
  return {
    persisted: storage.persisted,
    usageMiB: numberOrNull(storage.usageMiB),
    quotaMiB: numberOrNull(storage.quotaMiB),
    remainingMiB: numberOrNull(storage.remainingMiB),
    usagePercent: numberOrNull(storage.usagePercent),
    cache: storage.cache ? sanitizeCacheInfo(storage.cache) : null,
    error: storage.error ? canonicalStorageError(storage.error) : undefined,
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function roundMiB(value: number | null): number | null {
  return value === null ? null : Math.round((value / 1024 / 1024) * 10) / 10
}

type DiagnosticProbeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; label: DiagnosticProbeLabel }

type DiagnosticProbeLabel =
  | "Cachepr\u00fcfung"
  | "Persistenzpr\u00fcfung"
  | "Speicherquotenpr\u00fcfung"

async function runDiagnosticProbe<T>(
  label: DiagnosticProbeLabel,
  operation: () => Promise<T>,
): Promise<DiagnosticProbeResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          label + " antwortete nicht innerhalb von " +
            STORAGE_PROBE_TIMEOUT_MS + " ms.",
        )
        error.name = "TimeoutError"
        reject(error)
      }, STORAGE_PROBE_TIMEOUT_MS)
    })
    const value = await Promise.race([operation(), timeout])
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error, label }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function captureEnvironment(): DebugEnvironment {
  const nav = typeof navigator === "undefined" ? null : navigator
  let connection:
    | { saveData?: boolean; effectiveType?: string; type?: string }
    | undefined
  try {
    connection = nav && "connection" in nav
      ? (nav as Navigator & {
          connection?: {
            saveData?: boolean
            effectiveType?: string
            type?: string
          }
        }).connection
      : undefined
  } catch {
    // Restricted browser contexts may expose but deny navigator properties.
  }
  let topLevel: boolean | null = null
  if (typeof window !== "undefined") {
    try {
      topLevel = window.top === window.self
    } catch {
      topLevel = false
    }
  }
  let origin: string | null = null
  try {
    origin = typeof location === "undefined" ? null : location.origin
  } catch {
    // Opaque and restricted frames may deny location access.
  }
  let storageManager = false
  try {
    storageManager = Boolean(nav?.storage)
  } catch {
    // Report the remaining capabilities even if StorageManager is denied.
  }
  let serviceWorkerControlled = false
  try {
    serviceWorkerControlled = Boolean(nav?.serviceWorker?.controller)
  } catch {
    // Sandboxed contexts may deny service-worker access.
  }
  return {
    origin,
    browser: sanitizeDebugText(nav?.userAgent ?? "unbekannt").slice(0, 280),
    platform: sanitizeDebugText(nav?.platform ?? "unbekannt").slice(0, 120),
    mobile:
      nav && "userAgentData" in nav
        ? Boolean((nav as Navigator & {
            userAgentData?: { mobile?: boolean }
          }).userAgentData?.mobile)
        : nav
          ? /Android|iPhone|iPad|Mobile/iu.test(nav.userAgent)
          : null,
    online: typeof nav?.onLine === "boolean" ? nav.onLine : null,
    saveData:
      typeof connection?.saveData === "boolean" ? connection.saveData : null,
    connectionType: connection?.effectiveType ?? connection?.type ?? null,
    secureContext:
      typeof globalThis.isSecureContext === "boolean"
        ? globalThis.isSecureContext
        : false,
    topLevel,
    cacheStorage: typeof caches !== "undefined",
    storageManager,
    serviceWorkerControlled,
    webAssembly: typeof WebAssembly !== "undefined",
    webGpu: Boolean(nav && "gpu" in nav),
    crossOriginIsolated:
      typeof globalThis.crossOriginIsolated === "boolean"
        ? globalThis.crossOriginIsolated
        : false,
  }
}

async function captureStorage(
  api: DiagnosticsApi,
): Promise<DebugStorageSummary> {
  let cache: ModelCacheInfo | null = null
  let persisted: boolean | null = null
  let usage: number | null = null
  let quota: number | null = null
  const errors: string[] = []
  const note = (
    label: DiagnosticProbeLabel | "StorageManager",
    error: unknown,
  ): void => {
    const value = normalizedError(error)
    errors.push(label + ": " + value.name + ": " + value.message)
  }
  let storage: StorageManager | undefined
  try {
    storage = typeof navigator === "undefined"
      ? undefined
      : navigator.storage
  } catch (error) {
    note("StorageManager", error)
  }
  const [cacheProbe, persistedProbe, estimateProbe] = await Promise.all([
    runDiagnosticProbe("Cachepr\u00fcfung", () => api.getCacheInfo()),
    typeof storage?.persisted === "function"
      ? runDiagnosticProbe("Persistenzpr\u00fcfung", () => storage.persisted())
      : Promise.resolve(null),
    typeof storage?.estimate === "function"
      ? runDiagnosticProbe("Speicherquotenpr\u00fcfung", () => storage.estimate())
      : Promise.resolve(null),
  ])
  if (cacheProbe.ok) {
    cache = sanitizeCacheInfo(cacheProbe.value)
    persisted = cache.persistent ?? null
  } else {
    note(cacheProbe.label, cacheProbe.error)
  }
  if (persistedProbe) {
    if (persistedProbe.ok) {
      persisted = persistedProbe.value
    } else {
      note(persistedProbe.label, persistedProbe.error)
    }
  }
  if (estimateProbe) {
    if (estimateProbe.ok) {
      usage = numberOrNull(estimateProbe.value.usage)
      quota = numberOrNull(estimateProbe.value.quota)
    } else {
      note(estimateProbe.label, estimateProbe.error)
    }
  }
  const remaining =
    usage !== null && quota !== null ? Math.max(0, quota - usage) : null
  return {
    persisted,
    usageMiB: roundMiB(usage),
    quotaMiB: roundMiB(quota),
    remainingMiB: roundMiB(remaining),
    usagePercent:
      usage !== null && quota !== null && quota > 0
        ? Math.round((usage / quota) * 1000) / 10
        : null,
    cache,
    error: errors.length ? errors.join("; ").slice(0, 900) : undefined,
  }
}

function runtimeWithoutSensitiveError(
  status: RuntimeStatus | null,
): RuntimeStatus | null {
  if (!status) return null
  return {
    phase: status.phase,
    ...(status.loadSource ? { loadSource: status.loadSource } : {}),
    assessmentEngine: status.assessmentEngine,
    modelId: sanitizeDebugText(status.modelId),
    revision: sanitizeDebugText(status.revision),
    device: status.device,
    dtype: status.dtype,
    error: status.error
      ? canonicalErrorSignature(GENERIC_ERROR_NAME, status.error).message
      : undefined,
  }
}

function detailText(
  details: DebugTraceEvent["details"],
  key: string,
): string | null {
  const value = details?.[key]
  return typeof value === "string" ? value : null
}

function errorFinding(
  code: string,
  title: string,
  analysis: string,
  evidence: string[],
  action?: string,
  confidence: DebugFinding["confidence"] = "high",
): DebugFinding {
  return {
    code,
    severity: "error",
    confidence,
    title,
    analysis,
    action,
    evidence,
  }
}

function isQuotaFailureText(value: string): boolean {
  return /QuotaExceededError|quota(?:\s+exceeded)?|storage\s+(?:is\s+)?full|disk\s+(?:is\s+)?full|Speicher(?:platz)?(?:limit)?[^.]*\b(?:voll|ersch\u00f6pft|\u00fcberschritten)/iu
    .test(value)
}

function cacheFindings(
  events: readonly DebugTraceEvent[],
  environment: DebugEnvironment,
  storage: DebugStorageSummary,
  runtime: RuntimeStatus | null,
): DebugFinding[] {
  const findings: DebugFinding[] = []
  const cacheEvents = events.filter((event) => event.kind === "cache")
  const quota = cacheEvents.find((event) =>
    isQuotaFailureText((event.errorName ?? "") + " " + (event.message ?? "")),
  )
  const propagatedQuota = events.find((event) =>
    event.kind === "failure" &&
    isQuotaFailureText(
      (event.errorName ?? "") + " " + (event.message ?? ""),
    ),
  )
  const denied = cacheEvents.find((event) =>
    /SecurityError|NotAllowedError|InvalidStateError/iu.test(
      event.errorName ?? "",
    ),
  )
  const corrupt = cacheEvents.find((event) =>
    /corrupt|invalid|integrity/iu.test(event.outcome ?? ""),
  )
  if (quota) {
    findings.push(errorFinding(
      "cache-quota",
      "Der Browser konnte die Modelldaten wegen des Speicherlimits nicht sichern.",
      "Der Download kann jetzt funktionieren, muss nach einem Neustart aber erneut erfolgen.",
      ["Cache-Schreibfehler: " + (quota.errorName ?? "QuotaExceededError") + "."],
      "Speicherplatz und Browserrichtlinien pr\u00fcfen; danach erneut laden.",
    ))
  }
  const activeEngine = runtime?.assessmentEngine
  const activeCache = activeEngine
    ? storage.cache?.engines?.[activeEngine] ?? storage.cache
    : null
  const estimatedMiB = activeCache && activeCache.estimatedBytes > 0
    ? roundMiB(activeCache.estimatedBytes)
    : null
  if (
    !quota &&
    !propagatedQuota &&
    !denied &&
    !corrupt &&
    runtime?.phase === "error" &&
    activeCache &&
    activeCache.supported &&
    !(activeCache.downloadCached ?? activeCache.cached) &&
    estimatedMiB !== null &&
    storage.remainingMiB !== null &&
    activeCache.estimatedBytes > storage.remainingMiB * 1024 * 1024
  ) {
    findings.push({
      code: "storage-capacity-insufficient",
      severity: "error",
      confidence: "medium",
      title: "Die freie Browserquote reicht voraussichtlich nicht f\u00fcr das Modell.",
      analysis:
        "Die Modellgr\u00f6\u00dfe ist eine Gesamtsch\u00e4tzung; teilweise vorhandene Shards lassen sich aus der Cacheprobe nicht bytegenau abziehen.",
      action:
        "Speicherplatz freigeben oder ein kleineres Modell verwenden und den unvollst\u00e4ndigen Cache danach neu aufbauen.",
      evidence: [
        "Gesch\u00e4tzter Modellcache: " + estimatedMiB + " MiB.",
        "Freie Origin-Quote: " + storage.remainingMiB + " MiB.",
        "Cachedateien: " + activeCache.filesCached + "/" + activeCache.filesTotal + ".",
      ],
    })
  }
  if (denied) {
    findings.push(errorFinding(
      "cache-access-denied",
      "Der Browser verweigert den Zugriff auf den Modellcache.",
      "Das kann in privaten Sitzungen, restriktiven Frames oder durch Richtlinien auftreten.",
      ["Cache-Operation " + (denied.stage ?? "unbekannt") + ": " + denied.errorName + "."],
      "In einem normalen HTTPS-Profil testen und CacheStorage freigeben.",
    ))
  }
  if (corrupt) {
    findings.push(errorFinding(
      "cache-corrupt",
      "Ein Cacheeintrag war unvollst\u00e4ndig oder ver\u00e4ndert.",
      "Der Eintrag wurde nicht als vertrauensw\u00fcrdiges Artefakt verwendet.",
      ["Datei: " + (corrupt.artifact ?? "unbekannt") + "."],
      "Cache l\u00f6schen und \u00fcber eine unver\u00e4ndernde HTTPS-Verbindung neu laden.",
    ))
  }
  if (!environment.cacheStorage) {
    findings.push({
      code: "cache-unsupported",
      severity: "warning",
      confidence: "high",
      title: "CacheStorage ist in diesem Browserkontext nicht verf\u00fcgbar.",
      analysis: "Das Modell kann nicht verl\u00e4sslich f\u00fcr den n\u00e4chsten Browserstart gespeichert werden.",
      action: "HTTPS, normales Browserprofil und einen nicht-opaquen Frame verwenden.",
      evidence: ["globalThis.caches fehlt."],
    })
  }
  if (runtime?.phase === "ready" && activeCache && !activeCache.cached) {
    findings.push({
      code: "cache-incomplete",
      severity: "warning",
      confidence: "high",
      title: "Das Modell lief, ist aber nicht vollst\u00e4ndig f\u00fcr den Neustart gespeichert.",
      analysis: activeCache.filesCached + "/" + activeCache.filesTotal + " Dateien wurden im Cache gefunden.",
      action: "Cache-Schreibfehler, Speicherquote und Browserrichtlinien pr\u00fcfen.",
      evidence: ["Cachedateien: " + activeCache.filesCached + "/" + activeCache.filesTotal + "."],
    })
  }
  if (storage.persisted === false && activeCache?.cached) {
    findings.push({
      code: "storage-best-effort",
      severity: "info",
      confidence: "high",
      title: "Der Cache ist vorhanden, aber nicht dauerhaft gesch\u00fctzt.",
      analysis: "Der Browser darf ihn bei Speicherdruck oder durch eine Richtlinie sp\u00e4ter entfernen.",
      evidence: ["navigator.storage.persisted() meldet false."],
    })
  }
  if (storage.error) {
    findings.push({
      code: "storage-inspection-failed",
      severity: "warning",
      confidence: "high",
      title: "Der Speicherzustand konnte nicht vollst\u00e4ndig gelesen werden.",
      analysis: storage.error,
      action: "Private-/InPrivate-Modus und Websitedaten-Richtlinien pr\u00fcfen.",
      evidence: [storage.error],
    })
  }
  return findings
}

function httpFinding(event: DebugTraceEvent): DebugFinding | null {
  const status = event.httpStatus ?? 0
  const target =
    (event.host ?? "unbekannt") + "/" + (event.artifact ?? "Artefakt")
  const evidence = ["HTTP " + status + " von " + target + "."]
  if (status === 407) {
    return errorFinding(
      "proxy-auth",
      "Der Schulproxy verlangt eine Anmeldung.",
      "HTTP 407 stammt vom vorgeschalteten Proxy.",
      evidence,
      "Proxy-Anmeldung oder Freigabe durch die Schul-IT pr\u00fcfen.",
    )
  }
  if (status === 401) {
    return errorFinding(
      "http-auth-required",
      "Die Downloadquelle verlangt eine Anmeldung.",
      "HTTP 401 bedeutet, dass die angefragte Datei ohne passende Berechtigung nicht ausgeliefert wurde.",
      evidence,
      "Anmeldung, Freigabeliste und die verwendete Artefakt-URL pr\u00fcfen.",
    )
  }
  if (status === 403 || status === 451) {
    return errorFinding(
      "http-forbidden",
      "Der Download wurde durch die Gegenstelle oder eine Richtlinie abgelehnt.",
      "Der HTTP-Status belegt eine Ablehnung, aber nicht, welche Zwischenstelle sie erzeugt hat.",
      evidence,
      "Host und Dateityp in Filter, Proxy und Firewall freigeben.",
    )
  }
  if (status === 404) {
    return errorFinding(
      "asset-not-found",
      "Eine ben\u00f6tigte Modelldatei wurde nicht gefunden.",
      "Die angefragte Version oder Asset-URL passt nicht zum Bundle.",
      evidence,
      "Bundle- und Assetversion gemeinsam aktualisieren.",
    )
  }
  if (status === 416) {
    return errorFinding(
      "range-rejected",
      "Der Server oder Proxy hat den angefragten Byte-Bereich abgelehnt.",
      "HTTP 416 weist auf eine inkompatible oder ver\u00e4nderte Range-Antwort hin.",
      evidence,
      "Byte-Range und Content-Range im Schulnetz unver\u00e4ndert durchlassen.",
    )
  }
  if (status === 408) {
    return errorFinding(
      "http-timeout",
      "Server oder Gateway haben die Anfrage wegen Zeitablaufs beendet.",
      "HTTP 408 belegt einen Timeout auf dem HTTP-Pfad.",
      evidence,
      "Proxy-Zeitlimit und Drosselung pr\u00fcfen; danach erneut versuchen.",
    )
  }
  if (status === 425 || status === 429) {
    return errorFinding(
      "http-retry-later",
      "Die Downloadquelle verlangt einen sp\u00e4teren Wiederholungsversuch.",
      "HTTP " + status + " weist auf eine vor\u00fcbergehende Ablehnung oder Drosselung hin.",
      evidence,
      "Kurz warten und erneut versuchen; bei Wiederholung Rate-Limits des Gateways pr\u00fcfen.",
    )
  }
  if (status >= 500) {
    return errorFinding(
      "upstream-error",
      "Downloadserver oder Gateway melden einen Fehler.",
      "HTTP " + status + " ist ein Server-/Gatewayfehler.",
      evidence,
      "Sp\u00e4ter erneut versuchen und bei Wiederholung das Gatewayprotokoll pr\u00fcfen.",
    )
  }
  return null
}

function failureFinding(
  event: DebugTraceEvent,
  environment: DebugEnvironment,
): DebugFinding | null {
  const haystack = (event.errorName ?? "") + " " + (event.message ?? "")
  const evidence = [
    event.message ??
      (event.errorName ?? "Fehler") + " bei " +
        (event.artifact ?? event.stage ?? "Download") + ".",
  ]
  if (/AbortError/iu.test(event.errorName ?? "")) {
    return {
      code: "download-cancelled",
      severity: "info",
      confidence: "high",
      title: "Der Ladevorgang wurde absichtlich beendet.",
      analysis: "Ein Reset, Cache-Löschen oder Wechsel des Modelllaufs hat den laufenden Download abgebrochen.",
      evidence,
    }
  }
  if (isQuotaFailureText(haystack)) {
    return errorFinding(
      "cache-quota",
      "Der Browser konnte die Modelldaten wegen des Speicherlimits nicht sichern.",
      "Der WebLLM-Start endet, wenn ein notwendiger Cacheeintrag nicht geschrieben werden kann.",
      evidence,
      "Speicherplatz freigeben oder ein kleineres Modell verwenden; danach den unvollst\u00e4ndigen Cache neu laden.",
    )
  }
  if (/SecurityError|NotAllowedError|InvalidStateError/iu.test(haystack)) {
    return errorFinding(
      "access-denied",
      "Der Browser hat einen benoetigten technischen Zugriff verweigert.",
      "Eine Sicherheits- oder Berechtigungsregel hat den Vorgang beendet.",
      evidence,
      "Browserprofil, Frame-Sandbox und Schulrichtlinien pruefen.",
    )
  }
  if (event.stage === "download-policy") {
    return environment.online === false
      ? errorFinding(
          "offline",
          "Der Browser meldet keine Netzwerkverbindung.",
          "Der Modellcache war f\u00fcr einen Offline-Start unvollst\u00e4ndig.",
          evidence,
          "Online verbinden und den Modelldownload einmal vollst\u00e4ndig abschlie\u00dfen.",
        )
      : errorFinding(
          "download-not-authorized",
          "Der Modelldownload wurde nicht freigegeben.",
          "Die DownloadPolicy oder der Zustimmungsdialog hat den Netzabruf beendet.",
          evidence,
          "Download im Dialog erlauben oder die Schulrichtlinie pr\u00fcfen.",
        )
  }
  if (
    /Content-Range|Byte-?Bereich|Byte-Download unerwartet beendet|Range-(?:Anfrage|Antwort)|HTTP 200 statt|bereits geladenen Bytes|Prefix/iu
      .test(haystack)
  ) {
    return errorFinding(
      "range-response-invalid",
      "Eine Byte-Range-Antwort war nicht mit dem laufenden Download vereinbar.",
      "Der Server oder ein Proxy lieferte einen falschen Bereich, ein Vollobjekt an der falschen Stelle oder ge\u00e4nderte Pr\u00e4fixdaten.",
      evidence,
      "Range-, Content-Range- und Kompressionsbehandlung im Schulproxy pr\u00fcfen.",
    )
  }
  if (/AbortError|timeout|Zeit.*(?:abgelaufen|ueberschritten)|keine neuen Daten/iu.test(haystack)) {
    return errorFinding(
      "download-timeout",
      "Der Download wurde abgebrochen oder blieb zu lange stehen.",
      "Die Verbindung lieferte im vorgesehenen Zeitfenster keine vollst\u00e4ndigen Daten.",
      evidence,
      "Proxy-Zeitlimits und Drosselung pr\u00fcfen; danach erneut versuchen.",
    )
  }
  if (
    /zu wenig|unvollst|truncat|frueh.*beendet|vorzeitig|Leere (?:Voll-)?Download-Antwort/iu
      .test(haystack)
  ) {
    return errorFinding(
      "download-truncated",
      "Die Datei kam nur teilweise an.",
      "Der Datenstrom endete vor der erwarteten logischen Dateigr\u00f6\u00dfe.",
      evidence,
      "Proxy-Abbr\u00fcche, Objektgr\u00f6\u00dfenlimit und Verbindung pr\u00fcfen.",
    )
  }
  if (/zu viele|size mismatch|Groesse|statt\s+\d+\s+Bytes/iu.test(haystack)) {
    return errorFinding(
      "download-size-mismatch",
      "Die empfangene Dateigr\u00f6\u00dfe stimmt nicht.",
      "Eine Zwischenstelle kann Kompression, Range-Antwort oder Inhalt ver\u00e4ndert haben.",
      evidence,
      "Content-Encoding, Content-Length und Byte-Range im Proxyprotokoll vergleichen.",
    )
  }
  if (/integrity|sha-?256|hash|kein gueltiges|ungueltiges.*Artefakt/iu.test(haystack)) {
    return errorFinding(
      "integrity-failed",
      "Die Datei bestand die Integrit\u00e4tspr\u00fcfung nicht.",
      "L\u00e4nge, Dateistruktur oder SHA-256 stimmen nicht mit der gepinnten Runtime \u00fcberein.",
      evidence,
      "Proxy-/Antiviren-Umschreibung ausschalten und Cache neu aufbauen.",
    )
  }
  if (/ContextWindowSizeExceededError|ContextWindowError|Kontextfenster/iu.test(haystack)) {
    return errorFinding(
      "context-window-exceeded",
      "Die Anfrage war fuer das Kontextfenster des Modells zu lang.",
      "Die lokale Modelllaufzeit konnte Eingabe und Ausgabe nicht gemeinsam im Kontextfenster verarbeiten.",
      evidence,
      "Antwort oder Kriterien kuerzen oder die Auswertung in kleinere Abschnitte teilen.",
    )
  }
  if (
    /WebGPU|device lost|DXGI_ERROR_DEVICE_|VK_ERROR_DEVICE_LOST|object disposed|out of memory/iu
      .test(haystack)
  ) {
    return errorFinding(
      "webgpu-runtime-failed",
      "Die WebGPU-Laufzeit des Qualitaetsmodells ist ausgefallen.",
      "Grafiktreiber, Geraetespeicher oder eine verwaltete Hardwarebeschleunigungs-Richtlinie koennen den Lauf beenden.",
      evidence,
      "WebGPU und Hardwarebeschleunigung pruefen oder beim Kompaktmodell bleiben.",
      "medium",
    )
  }
  const embeddedHttpStatus = event.message?.match(/^HTTP ([1-5]\d{2})\.$/u)
  if (embeddedHttpStatus) {
    return httpFinding({
      ...event,
      httpStatus: Number(embeddedHttpStatus[1]),
    })
  }
  if (/TypeError/iu.test(event.errorName ?? "") || /Failed to fetch|NetworkError|Load failed/iu.test(haystack)) {
    if (environment.online === false) {
      return errorFinding(
        "offline",
        "Der Browser meldet keine Netzwerkverbindung.",
        "Die ben\u00f6tigte Datei war nicht vollst\u00e4ndig im Cache vorhanden.",
        evidence,
        "Online verbinden oder das Modell vorher vollst\u00e4ndig cachen.",
      )
    }
    return errorFinding(
      "network-blocked",
      "Der Browser konnte die Downloadquelle nicht erreichen.",
      "M\u00f6gliche Ursachen sind Schulfilter, Proxy, DNS, TLS oder CORS; der Browserfehler unterscheidet sie nicht sicher.",
      evidence,
      "Diagnose-ID mit Proxy-/Firewallprotokollen an die Schul-IT geben.",
      "medium",
    )
  }
  return null
}

function languageAnalysisFinding(event: DebugTraceEvent): DebugFinding {
  const attempts = event.details?.attempts
  const reason = detailText(event.details, "reason")
  const finishReason = detailText(event.details, "finishReason")
  const reasonText = reason === "request-error"
    ? "Die lokale Modellanfrage konnte nicht erfolgreich beendet werden."
    : reason === "incomplete-output"
      ? "Die lokale Modellausgabe war unvollständig."
      : "Die lokale Modellausgabe entsprach nicht dem erwarteten JSON-Vertrag."
  const evidence = [
    (typeof attempts === "number" ? attempts : 0) +
      " Sprachprüfungsversuche; finish_reason=" +
      (finishReason ?? "missing") + ".",
  ]
  return {
    code: reason === "request-error"
      ? "language-analysis-request-failed"
      : "language-analysis-output-invalid",
    severity: "warning",
    confidence: "high",
    title: "Die Sprachstatistik wurde nicht abgeschlossen.",
    analysis:
      reasonText +
      " Die fachliche Auswertung bleibt davon unberührt; nur die angeforderten Fehlerzahlen fehlen.",
    action:
      "Die Aufgabe erneut prüfen. Tritt die Meldung wieder auf, die vollständige DebugNotiz weitergeben.",
    evidence,
  }
}

function languageAnalysisWasSuperseded(
  event: DebugTraceEvent,
  events: readonly DebugTraceEvent[],
): boolean {
  return events.some((candidate) =>
    candidate.kind === "language-analysis" &&
    candidate.sequence > event.sequence &&
    candidate.runId === event.runId &&
    candidate.engine === event.engine,
  )
}

function runtimeFailureFinding(runtime: RuntimeStatus | null): DebugFinding | null {
  if (runtime?.phase !== "error" || !runtime.error) return null
  const message = canonicalErrorSignature(
    GENERIC_ERROR_NAME,
    runtime.error,
  ).message
  const evidence = [message]
  if (/ContextWindowError|Kontextfenster/iu.test(message)) {
    return errorFinding(
      "context-window-exceeded",
      "Die Anfrage war fuer das Kontextfenster des Modells zu lang.",
      "Die lokale Modelllaufzeit konnte Eingabe und Ausgabe nicht gemeinsam im Kontextfenster verarbeiten.",
      evidence,
      "Antwort oder Kriterien kuerzen oder die Auswertung in kleinere Abschnitte teilen.",
    )
  }
  if (
    /Content Security Policy|Refused to|wasm-unsafe-eval|unsafe-eval|script-src|worker-src/iu
      .test(message)
  ) {
    return errorFinding(
      "runtime-csp-blocked",
      "Die Browser-Sicherheitsrichtlinie blockiert die lokale Modelllaufzeit.",
      "Der Download kann vollst\u00e4ndig sein, w\u00e4hrend CSP das Starten von JavaScript, WASM, Blob oder Worker verhindert.",
      evidence,
      "CSP f\u00fcr die ben\u00f6tigten connect-src-, script-src- und worker-src-Pfade pr\u00fcfen.",
    )
  }
  if (
    /WebGPU|GPU|requestAdapter|requestDevice|device lost|VK_ERROR|DXGI_ERROR_DEVICE_|adapter|object has already been disposed|cannot pass deleted object|out of (?:gpu )?memory/iu
      .test(message)
  ) {
    return errorFinding(
      "webgpu-runtime-failed",
      "Die WebGPU-Laufzeit des Qualit\u00e4tsmodells konnte nicht gestartet werden.",
      "Browser, Grafiktreiber, Ger\u00e4tespeicher oder eine verwaltete Hardwarebeschleunigungs-Richtlinie k\u00f6nnen den Start verhindern.",
      evidence,
      "WebGPU und Hardwarebeschleunigung pr\u00fcfen oder beim Kompaktmodell bleiben.",
      "medium",
    )
  }
  if (
    /ONNX|WASM|WebAssembly|InferenceSession|execution provider|backend|instantiate|CompileError|LinkError/iu
      .test(message)
  ) {
    return errorFinding(
      "onnx-wasm-runtime-failed",
      "Die lokale ONNX-/WASM-Laufzeit konnte nicht initialisiert werden.",
      "Die Runtime-Dateien wurden erreicht, konnten im aktuellen Browserkontext aber nicht gestartet werden.",
      evidence,
      "WASM-Unterst\u00fctzung, Browserrichtlinien, Integrit\u00e4t und verf\u00fcgbaren Speicher pr\u00fcfen.",
      "medium",
    )
  }
  return null
}

function responseWasRecovered(
  event: DebugTraceEvent,
  events: readonly DebugTraceEvent[],
): boolean {
  const requestHost = detailText(event.details, "requestedHost") ?? event.host
  const requestArtifact =
    detailText(event.details, "requestedArtifact") ?? event.artifact
  return events.some((candidate) => {
    if (
      candidate.kind !== "fetch-response" ||
      candidate.sequence <= event.sequence ||
      candidate.runId !== event.runId ||
      (candidate.httpStatus ?? 0) < 200 ||
      (candidate.httpStatus ?? 0) >= 300
    ) {
      return false
    }
    const candidateHost =
      detailText(candidate.details, "requestedHost") ?? candidate.host
    const candidateArtifact =
      detailText(candidate.details, "requestedArtifact") ?? candidate.artifact
    return candidateHost === requestHost && candidateArtifact === requestArtifact
  })
}

export function classifyDebugFindings(
  rawEvents: readonly DebugTraceEvent[],
  environment: DebugEnvironment,
  rawStorage: DebugStorageSummary,
  rawRuntime: RuntimeStatus | null,
): DebugFinding[] {
  const events = rawEvents.map(canonicalizeDebugEvent)
  const storage = sanitizeStorageSummary(rawStorage)
  const runtime = runtimeWithoutSensitiveError(rawRuntime)
  const cache = cacheFindings(events, environment, storage, runtime)
  const findings: DebugFinding[] = []
  for (const event of events) {
    let finding: DebugFinding | null = null
    if (
      event.kind === "fetch-response" &&
      (event.httpStatus ?? 0) >= 400 &&
      !responseWasRecovered(event, events)
    ) {
      finding = httpFinding(event)
    } else if (
      event.kind === "language-analysis" &&
      event.outcome === "unavailable" &&
      !languageAnalysisWasSuperseded(event, events)
    ) {
      finding = languageAnalysisFinding(event)
    } else if (event.kind === "failure") {
      finding = failureFinding(event, environment)
    }
    if (finding) findings.push(finding)
  }
  const runtimeFinding = runtimeFailureFinding(runtime)
  if (runtimeFinding) findings.push(runtimeFinding)

  const responses = events.filter((event) => event.kind === "fetch-response")
  const activities = events.filter((event) => event.kind === "fetch-activity")
  for (const response of responses) {
    const contentLength = detailText(response.details, "contentLength")
    const headerLength = Number(contentLength)
    const activity = activities.find((candidate) =>
      (response.transport ?? "direct") === "direct" &&
      !detailText(response.details, "range") &&
      !detailText(response.details, "contentRange") &&
      (response.httpStatus ?? 0) >= 200 &&
      (response.httpStatus ?? 0) < 300 &&
      (candidate.runId ?? "untracked") ===
        (response.runId ?? "untracked") &&
      candidate.host === response.host &&
      candidate.artifact === response.artifact &&
      candidate.elapsedMs >= response.elapsedMs &&
      candidate.loaded !== undefined,
    )
    if (
      contentLength !== null &&
      Number.isFinite(headerLength) &&
      headerLength > 0 &&
      activity?.loaded !== undefined &&
      activity.loaded !== headerLength &&
      activity.expected === activity.loaded
    ) {
      findings.push({
        code: "decoded-transfer-length",
        severity: "info",
        confidence: "high",
        title: "Die Transportl\u00e4nge war komprimiert; der dekodierte Inhalt ist korrekt.",
        analysis: "Content-Length ist hier nur die \u00dcbertragungsl\u00e4nge und kein Downloadfehler.",
        evidence: [
          "Header " + headerLength + " Bytes, logisch " +
            activity.loaded + " Bytes.",
        ],
      })
    }
  }

  const retryEvents = events.filter((event) =>
    event.kind === "fetch-retry" || event.kind === "fetch-attempt-error",
  )
  const terminalFailures = events.filter((event) =>
    event.kind === "failure" &&
    !/AbortError/iu.test(event.errorName ?? ""),
  )
  if (retryEvents.length > 0) {
    const recovered =
      runtime?.phase === "ready" ||
      (runtime?.phase !== "error" && terminalFailures.length === 0)
    findings.push({
      code: recovered ? "network-retry-recovered" : "network-retries-observed",
      severity: "info",
      confidence: "high",
      title: recovered
        ? "Eine vorübergehende Netzwerkunterbrechung wurde ausgeglichen."
        : "Vor dem endgültigen Fehler gab es erneute Downloadversuche.",
      analysis: recovered
        ? "Mindestens ein Einzelversuch scheiterte, der Modelllauf endete dadurch aber nicht mit einem terminalen Downloadfehler."
        : "Die Wiederholungsversuche sind Begleitinformationen; die terminale Ursache wird getrennt bewertet.",
      evidence: [retryEvents.length + " fehlgeschlagene Einzel-/Wiederholungsversuche."],
    })
  }

  const unique = new Map<string, DebugFinding>()
  const hasTerminalFailure =
    runtime?.phase === "error" || terminalFailures.length > 0
  const ordered = hasTerminalFailure
    ? [...findings, ...cache]
    : [...cache, ...findings]
  for (const finding of ordered) {
    if (!unique.has(finding.code)) unique.set(finding.code, finding)
  }
  const cancellationOnly =
    unique.has("download-cancelled") &&
    ![...unique.values()].some((finding) => finding.severity === "error")
  if (
    runtime?.phase === "error" &&
    !cancellationOnly &&
    ![...unique.values()].some((finding) => finding.severity === "error")
  ) {
    unique.set("unknown", errorFinding(
      "unknown",
      "Der Ladevorgang endete mit einem noch nicht klassifizierten Fehler.",
      "Die Ereignisfolge grenzt die Stelle ein, belegt aber keine eindeutige Ursache.",
      [runtime.error ?? GENERIC_ERROR_MESSAGE],
      "Den vollst\u00e4ndigen DebugNotiz-Block weitergeben.",
      "low",
    ))
  }
  return [...unique.values()]
}

function reportEvents(): DebugTraceEvent[] {
  const state = diagnosticState()
  const activityEvents = [...state.activities.values()].map((event, index) => ({
    ...event,
    sequence: state.sequence + index + 1,
  }))
  return [...state.events, ...activityEvents]
    .sort((left, right) =>
      left.elapsedMs - right.elapsedMs || left.sequence - right.sequence,
    )
}

function activeCache(
  storage: DebugStorageSummary,
  runtime: RuntimeStatus | null,
): ModelCacheInfo | null {
  const engine = runtime?.assessmentEngine
  if (engine && storage.cache?.engines?.[engine]) {
    return storage.cache.engines[engine] ?? null
  }
  return storage.cache
}

function reportOutcome(
  runtime: RuntimeStatus | null,
  storage: DebugStorageSummary,
  events: readonly DebugTraceEvent[],
): LiaLLMDebugReport["outcome"] {
  if (runtime?.phase === "error") {
    return "failed"
  }
  if (runtime?.phase === "ready" && activeCache(storage, runtime)?.cached === false) {
    return "cache-incomplete"
  }
  if (runtime?.phase === "ready") return "ready"
  return events.some((event) => event.kind === "failure")
    ? "failed"
    : "unknown"
}

function reportSummary(
  outcome: LiaLLMDebugReport["outcome"],
  finding: DebugFinding | undefined,
): string {
  if (finding) return finding.title
  if (outcome === "ready") {
    return "Das Modell ist bereit; es wurde kein aktueller Ladefehler erkannt."
  }
  if (outcome === "cache-incomplete") {
    return "Das Modell ist bereit, aber der Neustart-Cache ist unvollst\u00e4ndig."
  }
  return "Noch liegt kein eindeutig klassifizierbarer Ladefehler vor."
}

export async function createDebugReport(
  api: DiagnosticsApi,
  options: DebugReportOptions = {},
  trigger: DebugReportTrigger = "manual",
  automaticSnapshot?: AutomaticReportSnapshot,
): Promise<LiaLLMDebugReport> {
  const state = diagnosticState()
  state.api = api
  const unresolvedError = trigger === "manual" && !automaticSnapshot
    ? Object.values(state.lastErrors)
        .filter(
          (
            value,
          ): value is AutomaticReportSnapshot & { sequence: number } =>
            value !== undefined,
        )
        .sort((left, right) => right.sequence - left.sequence)[0]
    : undefined
  const selectedSnapshot = automaticSnapshot ?? unresolvedError
  let runtime: RuntimeStatus | null = null
  try {
    runtime = selectedSnapshot
      ? runtimeWithoutSensitiveError(selectedSnapshot.status)
      : runtimeWithoutSensitiveError(api.getStatus())
  } catch (error) {
    const normalized = normalizedError(error)
    appendEvent({
      kind: "failure",
      stage: "status-inspection",
      outcome: "failed",
      errorName: normalized.name,
      message: normalized.message,
    })
  }
  const environment = captureEnvironment()
  const engine = selectedSnapshot?.engine ?? runtime?.assessmentEngine
  const storage = await captureStorage(api)
  if (!storage.cache && engine && trigger === "load-error") {
    const previousCache = state.cacheSnapshots[engine]
    if (previousCache) storage.cache = sanitizeCacheInfo(previousCache)
  }
  const allEvents = reportEvents()
  const runId = selectedSnapshot?.runId ??
    (engine ? runIdFor(engine) : "manual-" + state.sequence)
  const runStart = allEvents.find((event) =>
    event.kind === "load-start" && event.runId === runId,
  )?.elapsedMs ?? 0
  const events = engine
    ? allEvents.filter((event) =>
        event.engine === undefined
          ? event.elapsedMs >= runStart
          : event.engine === engine && event.runId === runId,
      ).slice(-35)
    : allEvents.slice(-35)
  const findings = classifyDebugFindings(
    events,
    environment,
    storage,
    runtime,
  )
  const outcome = reportOutcome(runtime, storage, events)
  const primary =
    findings.find((finding) => finding.severity === "error") ??
    findings.find((finding) => finding.severity === "warning") ??
    findings[0]
  const report: LiaLLMDebugReport = {
    schemaVersion: 1,
    libraryVersion: api.version,
    generatedAt: new Date().toISOString(),
    runId,
    trigger,
    outcome,
    summary: reportSummary(outcome, primary),
    primaryCause: primary?.code ?? "none-observed",
    runtime,
    environment,
    storage,
    findings,
    events,
    privacy: {
      localOnly: true,
      studentContentLogged: false,
      responseBodiesLogged: false,
      stacksLogged: false,
      urlPolicy: "origin-host-and-artifact-only",
    },
  }
  if (options.print !== false) printDebugReport(report)
  return report
}

function tableRows(report: LiaLLMDebugReport): Array<Record<string, unknown>> {
  const cache = activeCache(report.storage, report.runtime)
  const transfer = [...report.events].reverse().find((event) =>
    event.kind === "fetch-response" ||
    event.kind === "fetch-activity" ||
    event.kind === "failure",
  )
  const row = (Bereich: string, Wert: unknown): Record<string, unknown> => ({
    Bereich,
    Wert: Wert ?? "unbekannt",
  })
  return [
    row("Diagnose-ID", report.runId),
    row("Zeitpunkt", report.generatedAt),
    row("Modell", report.runtime?.assessmentEngine),
    row("Phase", report.runtime?.phase),
    row("Vermutete Ursache", report.primaryCause),
    row("Letzter Host", transfer?.host),
    row("Letzte Datei", transfer?.artifact),
    row("HTTP", transfer?.httpStatus),
    row("Bytes Ist", transfer?.loaded),
    row("Bytes Soll", transfer?.expected),
    row("CacheStorage", report.environment.cacheStorage),
    row(
      "Cachedateien",
      cache ? cache.filesCached + "/" + cache.filesTotal : "unbekannt",
    ),
    row("Persistenter Speicher", report.storage.persisted),
    row("Speichernutzung MiB", report.storage.usageMiB),
    row("Speicherquote MiB", report.storage.quotaMiB),
    row("Browser online", report.environment.online),
    row("Verbindung", report.environment.connectionType),
    row("Service Worker", report.environment.serviceWorkerControlled),
    row("WebGPU", report.environment.webGpu),
    row("Sicherer Kontext", report.environment.secureContext),
    row("Browser / OS", report.environment.browser),
  ]
}

export function printDebugReport(report: LiaLLMDebugReport): void {
  const prefix = "[Lia-LLM DebugNotiz " + report.runId + "]"
  const model = report.runtime?.assessmentEngine === "quality"
    ? "Qualit\u00e4tsmodell"
    : "Kompaktmodell"
  const primary = report.findings.find((finding) =>
    finding.code === report.primaryCause,
  )
  const hasWarning =
    report.outcome !== "failed" &&
    primary !== undefined &&
    primary.severity !== "info"
  const headline = report.outcome === "failed"
    ? "Das " + model + " konnte nicht geladen werden."
    : report.outcome === "cache-incomplete"
      ? "Das " + model + " wurde geladen, aber nicht vollst\u00e4ndig gecacht."
      : hasWarning
        ? "Das " + model + " wurde geladen; die Diagnose meldet ein Problem."
        : "Diagnose f\u00fcr das " + model + "."
  const logHeadline = report.outcome === "failed"
    ? console.error
    : report.outcome === "cache-incomplete" || hasWarning
      ? console.warn
      : console.info
  const marker = report.outcome === "failed"
    ? "\u274c"
    : report.outcome === "cache-incomplete" || hasWarning
      ? "\u26a0\ufe0f"
      : "\u2139\ufe0f"
  const headlineStyle = report.outcome === "failed"
    ? "color:#b00020;font-weight:bold"
    : report.outcome === "cache-incomplete" || hasWarning
      ? "color:#9a6700;font-weight:bold"
      : "color:#0969da;font-weight:bold"
  logHeadline.call(
    console,
    "%c" + marker + " " + prefix + " " + headline,
    headlineStyle,
  )
  console.groupCollapsed(prefix + " Technische Details - zum Aufklappen")
  try {
    console.log(
      "Vermutete Ursache (" + (primary?.confidence ?? "offen") + "):",
      report.summary,
    )
    if (primary?.evidence.length) {
      console.log("Belege:\n\u2022 " + primary.evidence.join("\n\u2022 "))
    }
    console.log(
      "Diese Einordnung ist eine technische Vermutung; \"online\" bedeutet nur, dass der Browser eine Netzverbindung sieht.",
    )
    console.table(tableRows(report))
    console.log("Diagnosedaten (Rechtsklick -> Copy object):", report)
    console.log(
      "Zum Weitergeben den Block zwischen BEGIN und END vollst\u00e4ndig kopieren. Er enth\u00e4lt keine Antworten oder Zugangsdaten.",
    )
    console.log(
      "--- BEGIN LIA-LLM DEBUGNOTIZ ---\n" +
        JSON.stringify(report, null, 2) +
        "\n--- END LIA-LLM DEBUGNOTIZ ---",
    )
    console.log(
      "Erneut abrufen: await LiaLLM.debugReport()",
      "Edge/Chrome kopieren: copy(JSON.stringify(await LiaLLM.debugReport({print:false}), null, 2))",
    )
  } finally {
    console.groupEnd()
  }
}

function relevantCacheWarning(report: LiaLLMDebugReport): boolean {
  return report.findings.some((finding) =>
    finding.severity !== "info" &&
    (/^cache-/u.test(finding.code) ||
      finding.code === "storage-inspection-failed"),
  )
}

async function emitAutomaticReport(
  trigger: DebugReportTrigger,
  snapshot: AutomaticReportSnapshot,
): Promise<void> {
  const state = diagnosticState()
  const api = state.api
  if (!api) return
  if (runIdFor(snapshot.engine) !== snapshot.runId) return
  try {
    const report = await createDebugReport(
      api,
      { print: false },
      trigger,
      snapshot,
    )
    if (runIdFor(snapshot.engine) !== snapshot.runId) return
    const cancellationOnly =
      report.findings.some((finding) =>
        finding.code === "download-cancelled",
      ) &&
      !report.findings.some((finding) => finding.severity === "error")
    if (trigger === "load-error" && cancellationOnly) return
    if (trigger === "load-error" || relevantCacheWarning(report)) {
      printDebugReport(report)
    }
  } catch (error) {
    const value = normalizedError(error)
    console.error(
      "[Lia-LLM DebugNotiz] Der Diagnosebericht f\u00fcr " +
        snapshot.engine + " konnte nicht erstellt werden: " + value.message,
    )
  }
}

function scheduleAutomaticReport(
  trigger: DebugReportTrigger,
  engine: AssessmentEngine,
  observedStatus?: RuntimeStatus,
): void {
  const state = diagnosticState()
  if (!state.api || !state.registered) return
  const runId = runIdFor(engine)
  let status = observedStatus ??
    state.lastErrors[engine]?.status ??
    state.latestStatuses[engine] ??
    null
  if (!status) {
    try {
      const current = runtimeWithoutSensitiveError(state.api.getStatus())
      status = current?.assessmentEngine === engine ? current : null
    } catch {
      // The event trace still identifies the engine and failing run.
    }
  }
  const snapshot: AutomaticReportSnapshot = {
    engine,
    runId,
    status: runtimeWithoutSensitiveError(status),
  }
  const key = trigger + ":" + engine + ":" + runId
  if (state.printed.has(key)) return
  state.printed.add(key)
  const run = (): void => {
    if (runIdFor(engine) !== runId) return
    void emitAutomaticReport(trigger, snapshot)
  }
  if (trigger === "post-ready-cache-check" && typeof setTimeout === "function") {
    setTimeout(run, 350)
  } else {
    Promise.resolve().then(run)
  }
}

function runtimeStatusFromEvent(event: Event): RuntimeStatus | null {
  const detail = (event as CustomEvent<unknown>).detail
  if (!detail || typeof detail !== "object") return null
  const value = detail as Record<string, unknown>
  const phases = ["idle", "loading", "ready", "error"] as const
  const engines = ["compact", "quality"] as const
  const devices = ["wasm", "webgpu"] as const
  const dtypes = ["q8", "fp32", "fp16", "q4", "q4f16"] as const
  if (
    !phases.includes(value.phase as (typeof phases)[number]) ||
    !engines.includes(value.assessmentEngine as (typeof engines)[number]) ||
    !devices.includes(value.device as (typeof devices)[number]) ||
    !dtypes.includes(value.dtype as (typeof dtypes)[number]) ||
    typeof value.modelId !== "string" ||
    typeof value.revision !== "string" ||
    (value.loadSource !== undefined &&
      value.loadSource !== "cache" &&
      value.loadSource !== "network") ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    return null
  }
  return runtimeWithoutSensitiveError({
    phase: value.phase as RuntimeStatus["phase"],
    ...(value.loadSource
      ? {
          loadSource: value.loadSource as NonNullable<
            RuntimeStatus["loadSource"]
          >,
        }
      : {}),
    assessmentEngine: value.assessmentEngine as AssessmentEngine,
    modelId: value.modelId,
    revision: value.revision,
    device: value.device as RuntimeStatus["device"],
    dtype: value.dtype as RuntimeStatus["dtype"],
    ...(value.error ? { error: value.error } : {}),
  })
}

export function registerDebugDiagnostics(api: LiaLLMApi): void {
  const state = diagnosticState()
  state.api = api
  if (state.registered) return
  state.registered = true
  if (typeof globalThis.addEventListener !== "function") return
  globalThis.addEventListener("lia-llm:status", (event) => {
    const rawStatus = runtimeStatusFromEvent(event)
    if (!rawStatus) return
    const status = rawStatus
    state.latestStatuses[status.assessmentEngine] = status
    const runId = runIdFor(status.assessmentEngine)
    const statusEvent = appendEvent({
      kind: "status",
      engine: status.assessmentEngine,
      runId,
      outcome: status.phase,
      message: status.error,
      details: {
        loadSource: status.loadSource ?? null,
        device: status.device,
        dtype: status.dtype,
      },
    })
    if (status.phase === "error") {
      state.lastErrors[status.assessmentEngine] = {
        engine: status.assessmentEngine,
        runId,
        status,
        sequence: statusEvent.sequence,
      }
      scheduleAutomaticReport("load-error", status.assessmentEngine, status)
      return
    }
    delete state.lastErrors[status.assessmentEngine]
    if (status.phase === "ready") {
      if (!state.checkedReadyRuns.has(runId)) {
        state.checkedReadyRuns.add(runId)
        scheduleAutomaticReport(
          "post-ready-cache-check",
          status.assessmentEngine,
          status,
        )
      }
    }
  })
}
