import { DEFAULT_MODEL_ESTIMATED_BYTES } from "./model-config.ts"
import type { LiaLLMApi, ModelProgress, RuntimeStatus } from "./types.ts"

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
    "#lia-llm-load-overlay[data-error='1']{pointer-events:auto}",
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
    "#lia-llm-load-overlay .lia-llm-load-hint{margin-top:3px;font-size:.82em;opacity:.6}",
    "#lia-llm-load-overlay .lia-llm-load-error{display:none;align-items:center;",
    "justify-content:flex-end;margin-top:10px}",
    "#lia-llm-load-overlay[data-error='1'] .lia-llm-load-error{display:flex}",
    "#lia-llm-load-overlay .lia-llm-retry{border:1px solid currentColor;border-radius:999px;",
    "padding:6px 12px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-weight:650}",
    "#lia-llm-load-overlay .lia-llm-retry:disabled{cursor:wait;opacity:.55}",
    "@keyframes lia_llm_load_indeterminate{0%{transform:translateX(-120%)}",
    "100%{transform:translateX(320%)}}",
    "@media (prefers-reduced-motion:reduce){",
    "#lia-llm-load-overlay[data-indeterminate='1'] .lia-llm-load-fill{animation-duration:2.2s}}",
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
    '<div class="lia-llm-load-hint"></div>',
    '<div class="lia-llm-load-error">',
    '<button class="lia-llm-retry" type="button">Erneut versuchen</button>',
    "</div>",
  ].join("")

  const titleNode = overlay.querySelector<HTMLElement>(".lia-llm-load-title")!
  const percentNode = overlay.querySelector<HTMLElement>(".lia-llm-load-percent")!
  const trackNode = overlay.querySelector<HTMLElement>(".lia-llm-load-track")!
  const fillNode = overlay.querySelector<HTMLElement>(".lia-llm-load-fill")!
  const detailNode = overlay.querySelector<HTMLElement>(".lia-llm-load-detail")!
  const hintNode = overlay.querySelector<HTMLElement>(".lia-llm-load-hint")!
  const retryButton = overlay.querySelector<HTMLButtonElement>(".lia-llm-retry")!

  hintNode.textContent =
    "Erster vollständiger Download: rund " +
    formatBytes(DEFAULT_MODEL_ESTIMATED_BYTES) +
    " Modellartefakte plus Laufzeit; anschließend aus dem Browsercache."

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
    overlay!.dataset.on = "0"
    overlay!.setAttribute("aria-hidden", "true")
    overlay!.setAttribute("aria-busy", "false")
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
    clearHideTimer()
    overlay!.dataset.error = "0"
    titleNode.textContent = "Lokales Bewertungsmodell wird geladen …"
    retryButton.hidden = true

    const percent = progressPercent(progress)
    setDeterminate(percent)

    const file = shortFileName(progress?.file)
    const transferred =
      progress &&
      finiteNumber(progress.loaded) &&
      finiteNumber(progress.total) &&
      progress.total > 0
        ? formatBytes(progress.loaded) + " von " + formatBytes(progress.total)
        : null

    if (progress?.status === "fallback" && progress.message) {
      detailNode.textContent = progress.message
    } else if (file && transferred) {
      detailNode.textContent = "Lade " + file + " – " + transferred + "."
    } else if (file) {
      detailNode.textContent = "Lade " + file + "."
    } else if (transferred) {
      detailNode.textContent = "Lade Modelldaten – " + transferred + "."
    } else if (progress?.message) {
      detailNode.textContent = progress.message
    } else {
      detailNode.textContent = "Laufzeit und Modelldaten werden vorbereitet …"
    }

    show(true)
  }

  const renderStatus = (status: RuntimeStatus): void => {
    currentStatus = status

    if (status.phase === "loading") {
      renderLoading(null)
      return
    }

    clearHideTimer()
    if (status.phase === "ready") {
      overlay!.dataset.error = "0"
      titleNode.textContent = "Bewertungsmodell ist bereit."
      detailNode.textContent = "Die Antwort wird jetzt lokal ausgewertet."
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
    if (currentStatus.phase !== "loading") return
    renderLoading((event as CustomEvent<ModelProgress>).detail)
  }

  const onStatus = (event: Event): void => {
    renderStatus((event as CustomEvent<RuntimeStatus>).detail)
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
  globalThis.addEventListener("lia-llm:progress", onProgress)
  globalThis.addEventListener("lia-llm:status", onStatus)

  renderStatus(currentStatus)
}
