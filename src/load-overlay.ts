import { DOWNLOAD_CONSENT_EVENT } from "./download-policy.ts"
import type {
  LiaLLMApi,
  ModelDownloadConsentDetail,
  ModelProgress,
  RuntimeStatus,
} from "./types.ts"

const OVERLAY_ID = "lia-llm-load-overlay"
const READY_DELAY_MS = 900

interface ManagedOverlay extends HTMLElement {
  __liaLLMLoadOverlayBound?: boolean
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Transformers.js v4 reports progress as a percentage from 0 to 100.
 * When byte counts are available they are more reliable and take precedence.
 */
export function progressPercent(progress: ModelProgress | null): number | null {
  if (
    progress &&
    finiteNumber(progress.loaded) &&
    finiteNumber(progress.total) &&
    progress.total > 0
  ) {
    return Math.max(0, Math.min(100, (progress.loaded / progress.total) * 100))
  }
  if (progress && finiteNumber(progress.progress)) {
    return Math.max(0, Math.min(100, progress.progress))
  }
  return null
}

function formatBytes(value: number): string {
  const formatter = new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: value >= 10_000_000 ? 0 : 1,
  })
  if (value >= 1_000_000) return formatter.format(value / 1_000_000) + " MB"
  if (value >= 1_000) return formatter.format(value / 1_000) + " kB"
  return formatter.format(value) + " B"
}

function shortFileName(value: string | undefined): string | null {
  const name = value?.split(/[\\/]/u).pop()?.trim()
  return name || null
}

function localizedProgressMessage(value: string | undefined): string | null {
  const message = value?.trim()
  if (!message) return null
  const cachePrefix = "Loading model from cache"
  if (message.toLowerCase().startsWith(cachePrefix.toLowerCase())) {
    return (
      "Das Modell wird für diese Sitzung aus dem Browsercache vorbereitet" +
      message.slice(cachePrefix.length)
    )
  }
  return message
}

export function registerLoadOverlay(api: LiaLLMApi): void {
  if (
    typeof document === "undefined" ||
    typeof globalThis.addEventListener !== "function"
  ) {
    return
  }

  const mount = document.body ?? document.documentElement
  let overlay = document.getElementById(OVERLAY_ID) as ManagedOverlay | null

  if (overlay?.__liaLLMLoadOverlayBound) {
    if (overlay.parentNode !== mount) mount.appendChild(overlay)
    return
  }

  if (!overlay) {
    overlay = document.createElement("div")
    overlay.id = OVERLAY_ID
  }

  overlay.dataset.on = "0"
  overlay.dataset.indeterminate = "1"
  overlay.dataset.error = "0"
  overlay.dataset.consent = "0"
  overlay.dataset.background = "0"
  overlay.setAttribute("role", "status")
  overlay.setAttribute("aria-live", "polite")
  overlay.setAttribute("aria-atomic", "true")
  overlay.setAttribute("aria-hidden", "true")
  overlay.innerHTML = [
    "<style>",
    "#lia-llm-load-overlay{position:fixed;left:50%;top:12px;z-index:100001;",
    "display:none;width:min(680px,calc(100vw - 24px));max-width:calc(100vw - 24px);",
    "transform:translateX(-50%);box-sizing:border-box;padding:14px 16px;",
    "border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:14px;",
    "background:var(--lia-llm-overlay-bg,Canvas);color:var(--lia-llm-overlay-color,CanvasText);",
    "box-shadow:0 8px 32px rgba(0,0,0,.2),0 1px 4px rgba(0,0,0,.1);",
    "backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);",
    "pointer-events:none;font:inherit}",
    "#lia-llm-load-overlay[data-on='1']{display:block}",
    "#lia-llm-load-overlay[data-background='1'][data-consent='0']{",
    "left:auto;right:12px;width:min(460px,calc(100vw - 24px));",
    "transform:none;padding:10px 12px}",
    "#lia-llm-load-overlay[data-error='1'],",
    "#lia-llm-load-overlay[data-consent='1']{pointer-events:auto}",
    "#lia-llm-load-overlay .lia-llm-load-head{display:flex;align-items:center;",
    "justify-content:space-between;gap:12px}",
    "#lia-llm-load-overlay .lia-llm-load-title{font-size:1.05em;font-weight:700}",
    "#lia-llm-load-overlay .lia-llm-load-percent{min-width:3.5em;text-align:right;",
    "font-variant-numeric:tabular-nums;font-weight:700;opacity:.78}",
    "#lia-llm-load-overlay .lia-llm-load-track{height:5px;width:100%;margin-top:10px;",
    "overflow:hidden;border-radius:999px;background:color-mix(in srgb,currentColor 16%,transparent)}",
    "#lia-llm-load-overlay .lia-llm-load-fill{height:100%;width:0;border-radius:inherit;",
    "background:currentColor;opacity:.72;transition:width .2s ease}",
    "#lia-llm-load-overlay[data-indeterminate='1'] .lia-llm-load-fill{width:35%;",
    "transition:none;animation:lia_llm_load_indeterminate 1.1s ease-in-out infinite}",
    "#lia-llm-load-overlay .lia-llm-load-detail{margin-top:6px;overflow-wrap:anywhere;",
    "font-size:.9em;opacity:.78}",
    "#lia-llm-load-overlay .lia-llm-load-error{display:none;align-items:center;",
    "justify-content:flex-end;margin-top:10px}",
    "#lia-llm-load-overlay[data-error='1'] .lia-llm-load-error{display:flex}",
    "#lia-llm-load-overlay .lia-llm-retry{border:1px solid currentColor;border-radius:999px;",
    "padding:6px 12px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-weight:650}",
    "#lia-llm-load-overlay .lia-llm-retry:disabled{cursor:wait;opacity:.55}",
    "#lia-llm-load-overlay .lia-llm-consent{display:none}",
    "#lia-llm-load-overlay[data-consent='1'] .lia-llm-consent{display:block}",
    "#lia-llm-load-overlay[data-consent='1'] .lia-llm-load-head,",
    "#lia-llm-load-overlay[data-consent='1'] .lia-llm-load-track,",
    "#lia-llm-load-overlay[data-consent='1'] .lia-llm-load-detail,",
    "#lia-llm-load-overlay[data-consent='1'] .lia-llm-load-error{display:none}",
    "#lia-llm-load-overlay .lia-llm-consent-title{font-size:1.05em;font-weight:700}",
    "#lia-llm-load-overlay .lia-llm-consent-text{margin-top:7px;line-height:1.4}",
    "#lia-llm-load-overlay .lia-llm-consent-actions{display:flex;flex-wrap:wrap;",
    "justify-content:flex-end;gap:8px;margin-top:12px}",
    "#lia-llm-load-overlay .lia-llm-consent-button{border:1px solid currentColor;",
    "border-radius:999px;padding:7px 13px;background:transparent;color:inherit;",
    "cursor:pointer;font:inherit;font-weight:650}",
    "#lia-llm-load-overlay .lia-llm-consent-download{background:currentColor}",
    "#lia-llm-load-overlay .lia-llm-consent-download span{color:Canvas}",
    "@keyframes lia_llm_load_indeterminate{0%{transform:translateX(-120%)}",
    "100%{transform:translateX(320%)}}",
    "@media (prefers-reduced-motion:reduce){",
    "#lia-llm-load-overlay[data-indeterminate='1'] .lia-llm-load-fill{animation-duration:2.2s}}",
    "@media (max-width:600px){",
    "#lia-llm-load-overlay[data-background='1'][data-consent='0']{",
    "top:8px;right:8px;width:calc(100vw - 16px);max-width:calc(100vw - 16px)}}",
    "</style>",
    '<div class="lia-llm-load-head">',
    '<span class="lia-llm-load-title">Lokales Bewertungsmodell wird geladen …</span>',
    '<span class="lia-llm-load-percent">…</span>',
    "</div>",
    '<div class="lia-llm-load-track" role="progressbar" ',
    'aria-label="Fortschritt beim Laden des Bewertungsmodells" ',
    'aria-valuemin="0" aria-valuemax="100">',
    '<div class="lia-llm-load-fill"></div></div>',
    '<div class="lia-llm-load-detail">Laufzeit und Modelldaten werden vorbereitet …</div>',
    '<div class="lia-llm-load-error">',
    '<button class="lia-llm-retry" type="button">Erneut versuchen</button>',
    "</div>",
    '<div class="lia-llm-consent">',
    '<div class="lia-llm-consent-title" id="lia-llm-consent-title"></div>',
    '<div class="lia-llm-consent-text" id="lia-llm-consent-text"></div>',
    '<div class="lia-llm-consent-actions">',
    '<button class="lia-llm-consent-button lia-llm-consent-cancel" type="button"></button>',
    '<button class="lia-llm-consent-button lia-llm-consent-download" type="button">',
    "<span>Herunterladen</span></button>",
    "</div></div>",
  ].join("")

  const titleNode = overlay.querySelector<HTMLElement>(".lia-llm-load-title")!
  const percentNode = overlay.querySelector<HTMLElement>(".lia-llm-load-percent")!
  const trackNode = overlay.querySelector<HTMLElement>(".lia-llm-load-track")!
  const fillNode = overlay.querySelector<HTMLElement>(".lia-llm-load-fill")!
  const detailNode = overlay.querySelector<HTMLElement>(".lia-llm-load-detail")!
  const retryButton = overlay.querySelector<HTMLButtonElement>(".lia-llm-retry")!
  const consentTitle = overlay.querySelector<HTMLElement>(
    ".lia-llm-consent-title",
  )!
  const consentText = overlay.querySelector<HTMLElement>(
    ".lia-llm-consent-text",
  )!
  const consentCancel = overlay.querySelector<HTMLButtonElement>(
    ".lia-llm-consent-cancel",
  )!
  const consentDownload = overlay.querySelector<HTMLButtonElement>(
    ".lia-llm-consent-download",
  )!

  try {
    const theme = getComputedStyle(mount)
    const background = theme.backgroundColor
    overlay.style.setProperty(
      "--lia-llm-overlay-color",
      theme.color || "CanvasText",
    )
    if (
      background &&
      background !== "transparent" &&
      background !== "rgba(0, 0, 0, 0)"
    ) {
      overlay.style.setProperty("--lia-llm-overlay-bg", background)
    }
  } catch {
    // The system colors above remain a readable fallback.
  }

  if (overlay.parentNode !== mount) mount.appendChild(overlay)
  overlay.__liaLLMLoadOverlayBound = true

  let currentStatus = api.getStatus()
  let currentConsent: ModelDownloadConsentDetail | null = null
  let previousFocus: HTMLElement | null = null
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const clearHideTimer = (): void => {
    if (hideTimer === undefined) return
    clearTimeout(hideTimer)
    hideTimer = undefined
  }

  const show = (busy: boolean): void => {
    overlay!.dataset.on = "1"
    overlay!.setAttribute("aria-hidden", "false")
    overlay!.setAttribute("aria-busy", String(busy))
  }

  const hide = (): void => {
    if (currentConsent) return
    overlay!.dataset.on = "0"
    overlay!.setAttribute("aria-hidden", "true")
    overlay!.setAttribute("aria-busy", "false")
  }

  const finishConsent = (allow: boolean): void => {
    const consent = currentConsent
    if (!consent) return

    currentConsent = null
    overlay!.dataset.consent = "0"
    overlay!.setAttribute("role", "status")
    overlay!.setAttribute("aria-live", "polite")
    overlay!.removeAttribute("aria-labelledby")
    overlay!.removeAttribute("aria-describedby")
    consent.respond(allow)
    hide()

    const focusTarget = previousFocus
    previousFocus = null
    if (focusTarget?.isConnected) focusTarget.focus()
  }

  const setDeterminate = (percent: number | null): void => {
    if (percent === null) {
      overlay!.dataset.indeterminate = "1"
      percentNode.textContent = "…"
      fillNode.style.width = "35%"
      trackNode.removeAttribute("aria-valuenow")
      trackNode.setAttribute("aria-valuetext", "Wird vorbereitet")
      return
    }

    overlay!.dataset.indeterminate = "0"
    const rounded = Math.round(percent)
    percentNode.textContent = String(rounded) + " %"
    fillNode.style.width = String(percent) + "%"
    trackNode.setAttribute("aria-valuenow", String(rounded))
    trackNode.removeAttribute("aria-valuetext")
  }

  const renderLoading = (progress: ModelProgress | null): void => {
    if (currentConsent) return
    clearHideTimer()
    overlay!.dataset.error = "0"
    titleNode.textContent =
      currentStatus.assessmentEngine === "quality"
        ? "Qualitätsmodell wird heruntergeladen …"
        : "Kompaktmodell für die erste Auswertung wird geladen …"
    retryButton.hidden = true

    const percent = progressPercent(progress)
    setDeterminate(percent)

    const file = shortFileName(progress?.file)
    const message = localizedProgressMessage(progress?.message)
    const transferred =
      progress &&
      finiteNumber(progress.loaded) &&
      finiteNumber(progress.total) &&
      progress.total > 0
        ? formatBytes(progress.loaded) + " von " + formatBytes(progress.total)
        : null

    if (progress?.status === "fallback" && message) {
      detailNode.textContent = message
    } else if (file && transferred) {
      detailNode.textContent = "Lade " + file + " – " + transferred + "."
    } else if (file) {
      detailNode.textContent = "Lade " + file + "."
    } else if (transferred) {
      detailNode.textContent = "Lade Modelldaten – " + transferred + "."
    } else if (message) {
      detailNode.textContent = message
    } else {
      detailNode.textContent = "Laufzeit und Modelldaten werden vorbereitet …"
    }

    show(true)
  }

  const renderStatus = (status: RuntimeStatus): void => {
    currentStatus = status
    if (currentConsent) return
    overlay!.dataset.background =
      status.assessmentEngine === "quality" ? "1" : "0"

    if (
      status.loadSource === "cache" &&
      (status.phase === "loading" || status.phase === "ready")
    ) {
      clearHideTimer()
      overlay!.dataset.error = "0"
      hide()
      return
    }

    if (status.phase === "loading") {
      renderLoading(null)
      return
    }

    clearHideTimer()
    if (status.phase === "ready") {
      overlay!.dataset.error = "0"
      titleNode.textContent =
        status.assessmentEngine === "quality"
          ? "Stärkeres Qualitätsmodell ist bereit."
          : "Kompaktmodell ist bereit."
      detailNode.textContent =
        status.assessmentEngine === "quality"
          ? "Spätere Antworten werden automatisch mit dem stärkeren Modell ausgewertet."
          : "Die Antwort wird jetzt lokal ausgewertet."
      retryButton.hidden = true
      setDeterminate(100)
      show(false)
      hideTimer = setTimeout(() => {
        if (currentStatus.phase === "ready") hide()
      }, READY_DELAY_MS)
      return
    }

    if (status.phase === "error") {
      overlay!.dataset.error = "1"
      titleNode.textContent = "Bewertungsmodell konnte nicht geladen werden."
      detailNode.textContent = status.error ?? "Unbekannter Fehler."
      retryButton.hidden = false
      setDeterminate(0)
      show(false)
      return
    }

    overlay!.dataset.error = "0"
    hide()
  }

  const onProgress = (event: Event): void => {
    if (currentConsent) return
    if (currentStatus.phase !== "loading") return
    if (currentStatus.loadSource === "cache") return
    const progress = (event as CustomEvent<ModelProgress>).detail
    if (
      progress?.message
        ?.trim()
        .toLowerCase()
        .startsWith("loading model from cache")
    ) {
      hide()
      return
    }
    renderLoading(progress)
  }

  const onStatus = (event: Event): void => {
    if (currentConsent) return
    const status = (event as CustomEvent<RuntimeStatus>).detail
    const activeStatus = api.getStatus()
    if (
      (status.assessmentEngine === "quality" &&
        status.phase === "error" &&
        activeStatus.assessmentEngine === "compact") ||
      (status.assessmentEngine === "compact" &&
        status.phase === "idle" &&
        activeStatus.assessmentEngine === "quality" &&
        activeStatus.phase === "ready")
    ) {
      renderStatus(activeStatus)
      return
    }
    renderStatus(status)
  }

  const onConsent = (event: Event): void => {
    const detail = (event as CustomEvent<ModelDownloadConsentDetail>).detail
    if (!detail || typeof detail.respond !== "function") return
    detail.handled = true
    if (currentConsent) finishConsent(false)

    currentConsent = detail
    previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    clearHideTimer()
    overlay!.dataset.error = "0"
    overlay!.dataset.background = "0"
    overlay!.dataset.consent = "1"
    overlay!.setAttribute("role", "alertdialog")
    overlay!.setAttribute("aria-live", "assertive")
    overlay!.setAttribute("aria-labelledby", "lia-llm-consent-title")
    overlay!.setAttribute("aria-describedby", "lia-llm-consent-text")
    consentTitle.textContent =
      detail.engine === "quality"
        ? "Qualit\u00e4tsmodell herunterladen?"
        : "Kompaktmodell herunterladen?"
    consentText.textContent =
      detail.modelName +
      " ben\u00f6tigt rund " +
      formatBytes(detail.estimatedBytes) +
      " und bleibt anschlie\u00dfend im Browsercache."
    consentCancel.textContent =
      detail.engine === "quality"
        ? "Beim kleinen Modell bleiben"
        : "Abbrechen"
    show(false)

    detail.signal?.addEventListener(
      "abort",
      () => {
        if (currentConsent?.id === detail.id) finishConsent(false)
      },
      { once: true },
    )
    queueMicrotask(() => {
      if (currentConsent?.id === detail.id) consentDownload.focus()
    })
  }

  retryButton.addEventListener("click", () => {
    retryButton.disabled = true
    void api
      .preload()
      .catch(() => undefined)
      .finally(() => {
        retryButton.disabled = false
      })
  })
  consentCancel.addEventListener("click", () => finishConsent(false))
  consentDownload.addEventListener("click", () => finishConsent(true))
  globalThis.addEventListener("lia-llm:progress", onProgress)
  globalThis.addEventListener("lia-llm:status", onStatus)
  globalThis.addEventListener(DOWNLOAD_CONSENT_EVENT, onConsent)

  renderStatus(currentStatus)
}
