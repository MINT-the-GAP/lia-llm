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
  lastErrorStatuses: Partial<Record<AssessmentEngine, RuntimeStatus>>
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
    lastErrorStatuses: {},
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

function normalizedError(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return {
      name: sanitizeDebugText(error.name || "Error"),
      message: sanitizeDebugText(error.message),
    }
  }
  return { name: "Error", message: sanitizeDebugText(error) }
}

function appendEvent(
  event: Omit<DebugTraceEvent, "sequence" | "elapsedMs">,
): DebugTraceEvent {
  const state = diagnosticState()
  const complete: DebugTraceEvent = {
    ...event,
    sequence: ++state.sequence,
    elapsedMs: elapsedMs(),
  }
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
  delete state.lastErrorStatuses[engine]
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
    ? Object.fromEntries(
        Object.entries(cache.engines).map(([engine, value]) => [
          engine,
          value ? sanitizeCacheInfo(value) : value,
        ]),
      ) as ModelCacheInfo["engines"]
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
    error: cache.error ? sanitizeDebugText(cache.error) : undefined,
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
  | { ok: false; error: unknown }

async function runDiagnosticProbe<T>(
  label: string,
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
    return { ok: false, error }
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
  const note = (error: unknown): void => {
    const value = normalizedError(error)
    errors.push(value.name + ": " + value.message)
  }
  let storage: StorageManager | undefined
  try {
    storage = typeof navigator === "undefined"
      ? undefined
      : navigator.storage
  } catch (error) {
    note(error)
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
    note(cacheProbe.error)
  }
  if (persistedProbe) {
    if (persistedProbe.ok) {
      persisted = persistedProbe.value
    } else {
      note(persistedProbe.error)
    }
  }
  if (estimateProbe) {
    if (estimateProbe.ok) {
      usage = numberOrNull(estimateProbe.value.usage)
      quota = numberOrNull(estimateProbe.value.quota)
    } else {
      note(estimateProbe.error)
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
    error: status.error ? sanitizeDebugText(status.error) : undefined,
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

function cacheFindings(
  events: readonly DebugTraceEvent[],
  environment: DebugEnvironment,
  storage: DebugStorageSummary,
  runtime: RuntimeStatus | null,
): DebugFinding[] {
  const findings: DebugFinding[] = []
  const cacheEvents = events.filter((event) => event.kind === "cache")
  const quota = cacheEvents.find((event) =>
    /quota/iu.test((event.errorName ?? "") + " " + (event.message ?? "")),
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
  const denied = cacheEvents.find((event) =>
    /SecurityError|NotAllowedError|InvalidStateError/iu.test(
      event.errorName ?? "",
    ),
  )
  if (denied) {
    findings.push(errorFinding(
      "cache-access-denied",
      "Der Browser verweigert den Zugriff auf den Modellcache.",
      "Das kann in privaten Sitzungen, restriktiven Frames oder durch Richtlinien auftreten.",
      ["Cache-Operation " + (denied.stage ?? "unbekannt") + ": " + denied.errorName + "."],
      "In einem normalen HTTPS-Profil testen und CacheStorage freigeben.",
    ))
  }
  const corrupt = cacheEvents.find((event) =>
    /corrupt|invalid|integrity/iu.test(event.outcome ?? ""),
  )
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
  const activeEngine = runtime?.assessmentEngine
  const activeCache = activeEngine && storage.cache?.engines?.[activeEngine]
    ? storage.cache.engines[activeEngine] ?? null
    : storage.cache
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

function runtimeFailureFinding(runtime: RuntimeStatus | null): DebugFinding | null {
  if (runtime?.phase !== "error" || !runtime.error) return null
  const message = sanitizeDebugText(runtime.error)
  const evidence = [message]
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
    /WebGPU|GPU|requestAdapter|requestDevice|device lost|VK_ERROR|adapter/iu
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
  events: readonly DebugTraceEvent[],
  environment: DebugEnvironment,
  storage: DebugStorageSummary,
  runtime: RuntimeStatus | null,
): DebugFinding[] {
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
      [sanitizeDebugText(runtime.error ?? "Unbekannter Laufzeitfehler")],
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
  let runtime: RuntimeStatus | null = null
  try {
    runtime = automaticSnapshot
      ? runtimeWithoutSensitiveError(automaticSnapshot.status)
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
  const engine = automaticSnapshot?.engine ?? runtime?.assessmentEngine
  const storage = await captureStorage(api)
  if (!storage.cache && engine && trigger === "load-error") {
    const previousCache = state.cacheSnapshots[engine]
    if (previousCache) storage.cache = sanitizeCacheInfo(previousCache)
  }
  const allEvents = reportEvents()
  const runId = automaticSnapshot?.runId ??
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
  const hasStorageWarning =
    report.outcome !== "failed" &&
    primary !== undefined &&
    primary.severity !== "info"
  const headline = report.outcome === "failed"
    ? "Das " + model + " konnte nicht geladen werden."
    : report.outcome === "cache-incomplete"
      ? "Das " + model + " wurde geladen, aber nicht vollst\u00e4ndig gecacht."
      : hasStorageWarning
        ? "Das " + model + " wurde geladen; die Cache-Diagnose meldet ein Problem."
        : "Diagnose f\u00fcr das " + model + "."
  const logHeadline = report.outcome === "failed"
    ? console.error
    : report.outcome === "cache-incomplete" || hasStorageWarning
      ? console.warn
      : console.info
  const marker = report.outcome === "failed"
    ? "\u274c"
    : report.outcome === "cache-incomplete" || hasStorageWarning
      ? "\u26a0\ufe0f"
      : "\u2139\ufe0f"
  const headlineStyle = report.outcome === "failed"
    ? "color:#b00020;font-weight:bold"
    : report.outcome === "cache-incomplete" || hasStorageWarning
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
    state.lastErrorStatuses[engine] ??
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
    appendEvent({
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
      state.lastErrorStatuses[status.assessmentEngine] = status
      scheduleAutomaticReport("load-error", status.assessmentEngine, status)
      return
    }
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
