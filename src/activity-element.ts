import type {
  ActivityDisplayOptions,
  EvaluationProgressPhase,
} from "./types.ts"

interface ActivityState {
  runId: string
  phase: EvaluationProgressPhase
  message: string
  thinkingTimeLimitMs?: number
  thinkingTimeInitialMs?: number
  thinkingDeadlineMs?: number
  thinkingExpired?: boolean
  onCancel?: () => void | Promise<void>
  cancelRequested?: boolean
}

const activityById = new Map<string, ActivityState>()
const activityTimerById = new Map<string, ReturnType<typeof setInterval>>()
const retiredRunsById = new Map<string, Set<string>>()
const ACTIVITY_TIMER_INTERVAL_MS = 250
const RETIRED_RUN_LIMIT = 16
const ACTIVITY_MESSAGES: Record<EvaluationProgressPhase, string> = {
  "selecting-model": "Passendes Modell wird ausgewählt …",
  "preparing-compact": "Kompaktmodell wird vorbereitet …",
  "evaluating-compact": "Antwort wird schnell geprüft …",
  "preparing-quality": "Qualitätsprüfung wird vorbereitet …",
  "evaluating-quality": "Antwort wird gründlich geprüft …",
  "fallback-compact": "Prüfung wird mit dem Kompaktmodell abgeschlossen …",
}

const ACTIVITY_SHADOW_STYLE = `
.lia-llm-activity-status {
  display: grid;
  gap: .08rem;
}
.lia-llm-activity-label {
  display: grid;
  gap: .08rem;
  font-size: .78em;
  line-height: 1.25;
  text-align: right;
  opacity: .78;
}
.lia-llm-activity-countdown {
  font-variant-numeric: tabular-nums;
}
.lia-llm-activity-countdown[hidden] {
  display: none;
}
.lia-llm-activity-track {
  height: 3px;
  width: 100%;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 16%, transparent);
}
.lia-llm-activity-cancel {
  justify-self: end;
  border: 1px solid currentColor;
  border-radius: .3rem;
  padding: .18rem .55rem;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  opacity: .88;
}
.lia-llm-activity-cancel:hover,
.lia-llm-activity-cancel:focus-visible {
  opacity: 1;
}
.lia-llm-activity-cancel:disabled {
  cursor: default;
  opacity: .5;
}
.lia-llm-activity-cancel[hidden] {
  display: none;
}
.lia-llm-activity-fill {
  height: 100%;
  width: 32%;
  border-radius: inherit;
  background: currentColor;
  opacity: .7;
  animation: lia_llm_quiz_activity 1.05s ease-in-out infinite;
}
@keyframes lia_llm_quiz_activity {
  0% { transform: translateX(-115%); }
  100% { transform: translateX(360%); }
}
@media (prefers-reduced-motion: reduce) {
  .lia-llm-activity-fill { animation-duration: 2.1s; }
}
`

function ensureActivityShadow(element: HTMLElement): ShadowRoot {
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" })
  if (shadow.querySelector(".lia-llm-activity-message")) return shadow

  const ownerDocument = element.ownerDocument
  const style = ownerDocument.createElement("style")
  style.textContent = ACTIVITY_SHADOW_STYLE

  const status = ownerDocument.createElement("span")
  status.className = "lia-llm-activity-status"
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  status.setAttribute("aria-atomic", "true")

  const label = ownerDocument.createElement("span")
  label.className = "lia-llm-activity-label"

  const message = ownerDocument.createElement("span")
  message.className = "lia-llm-activity-message"

  const countdown = ownerDocument.createElement("span")
  countdown.className = "lia-llm-activity-countdown"
  countdown.setAttribute("aria-hidden", "true")
  countdown.hidden = true
  label.append(message, countdown)

  const track = ownerDocument.createElement("span")
  track.className = "lia-llm-activity-track"
  track.setAttribute("role", "progressbar")
  track.setAttribute("aria-label", "Fortschritt der lokalen Antwortauswertung")

  const fill = ownerDocument.createElement("span")
  fill.className = "lia-llm-activity-fill"
  track.append(fill)
  status.append(label, track)

  const cancel = ownerDocument.createElement("button")
  cancel.className = "lia-llm-activity-cancel"
  cancel.type = "button"
  cancel.textContent = "Prüfung abbrechen"
  cancel.hidden = true
  cancel.addEventListener("click", () => {
    const state = activityById.get(element.id)
    if (!state?.onCancel || cancel.disabled) return
    const restoreCancellation = (): void => {
      const current = activityById.get(element.id)
      if (!current || current.runId !== state.runId) return
      current.cancelRequested = false
      renderActivity(element, current)
    }
    state.cancelRequested = true
    cancel.disabled = true
    try {
      const result = state.onCancel()
      if (result && typeof result.then === "function") {
        void result.catch(restoreCancellation)
      }
    } catch {
      restoreCancellation()
    }
  })

  shadow.replaceChildren(style, status, cancel)
  return shadow
}

export function activityCountdownSeconds(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return 0
  return Math.max(0, Math.ceil(remainingMs / 1_000))
}

function positiveMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function stopActivityCountdown(id: string): void {
  const timer = activityTimerById.get(id)
  if (timer !== undefined) clearInterval(timer)
  activityTimerById.delete(id)
}

function retireRun(id: string, runId: string): void {
  const retired = retiredRunsById.get(id) ?? new Set<string>()
  retired.delete(runId)
  retired.add(runId)
  while (retired.size > RETIRED_RUN_LIMIT) {
    const oldest = retired.values().next().value
    if (typeof oldest !== "string") break
    retired.delete(oldest)
  }
  retiredRunsById.set(id, retired)
}

function setCountdownContent(
  countdown: HTMLElement,
  text: string,
  hidden: boolean,
): void {
  if (countdown.textContent !== text) countdown.textContent = text
  if (countdown.hidden !== hidden) countdown.hidden = hidden
}

function countdownText(
  element: HTMLElement,
  state: ActivityState,
  timestamp = Date.now(),
): boolean {
  const shadow = ensureActivityShadow(element)
  const countdown = shadow.querySelector<HTMLElement>(
    ".lia-llm-activity-countdown",
  )
  const status = shadow.querySelector<HTMLElement>(
    ".lia-llm-activity-status",
  )
  if (!countdown) return false

  if (state.thinkingDeadlineMs !== undefined) {
    const seconds = activityCountdownSeconds(
      state.thinkingDeadlineMs - timestamp,
    )
    if (seconds > 0) {
      setCountdownContent(
        countdown,
        `Zusätzliche Denkzeit: noch ${seconds} s.`,
        false,
      )
      return true
    }

    setCountdownContent(
      countdown,
      "Zusätzliche Denkzeit ist beendet. Die Auswertung wird ohne den Zusatzlauf abgeschlossen …",
      false,
    )
    if (!state.thinkingExpired) {
      state.thinkingExpired = true
      status?.setAttribute(
        "aria-label",
        `${state.message} Zusätzliche Denkzeit ist beendet. Die Auswertung wird ohne den Zusatzlauf abgeschlossen.`,
      )
    }
    return false
  }

  const limitSeconds = activityCountdownSeconds(
    state.thinkingTimeLimitMs ?? 0,
  )
  setCountdownContent(
    countdown,
    limitSeconds > 0
      ? `Zusätzlicher Denkmodus bei Bedarf: bis zu ${limitSeconds} s; die Grundprüfung kann je nach Gerät länger dauern.`
      : "",
    limitSeconds === 0,
  )
  return false
}

function scheduleActivityCountdown(
  element: HTMLElement,
  state: ActivityState,
): void {
  stopActivityCountdown(element.id)
  if (state.thinkingDeadlineMs === undefined) return
  if (!countdownText(element, state)) return

  const activityId = element.id
  const timer = setInterval(() => {
    if (
      element.id !== activityId ||
      activityTimerById.get(activityId) !== timer
    ) {
      clearInterval(timer)
      if (activityTimerById.get(activityId) === timer) {
        activityTimerById.delete(activityId)
      }
      return
    }
    if (activityById.get(activityId) !== state) {
      stopActivityCountdown(activityId)
      return
    }
    if (!countdownText(element, state)) {
      stopActivityCountdown(activityId)
    }
  }, ACTIVITY_TIMER_INTERVAL_MS)
  activityTimerById.set(activityId, timer)
}

function renderActivity(
  element: HTMLElement,
  state: ActivityState | undefined,
): void {
  const visible = Boolean(state)
  element.hidden = !visible
  element.style.display = visible ? "grid" : "none"

  const shadow = ensureActivityShadow(element)
  const status = shadow.querySelector<HTMLElement>(
    ".lia-llm-activity-status",
  )
  const message = shadow.querySelector<HTMLElement>(
    ".lia-llm-activity-message",
  )
  if (message) message.textContent = state?.message ?? ""
  const countdown = shadow.querySelector<HTMLElement>(
    ".lia-llm-activity-countdown",
  )
  if (!state && countdown) {
    countdown.textContent = ""
    countdown.hidden = true
  }
  const track = shadow.querySelector<HTMLElement>(".lia-llm-activity-track")
  if (track) {
    if (state) track.setAttribute("aria-valuetext", state.message)
    else track.removeAttribute("aria-valuetext")
  }
  const cancel = shadow.querySelector<HTMLButtonElement>(
    ".lia-llm-activity-cancel",
  )
  if (cancel) {
    cancel.hidden = !state?.onCancel
    cancel.disabled = state?.cancelRequested ?? false
  }

  if (!state) {
    status?.removeAttribute("aria-label")
    return
  }

  const announcedTimeMs =
    state.thinkingTimeInitialMs ?? state.thinkingTimeLimitMs
  const announcedSeconds = activityCountdownSeconds(announcedTimeMs ?? 0)
  if (announcedSeconds > 0) {
    status?.setAttribute(
      "aria-label",
      state.thinkingDeadlineMs === undefined
        ? `${state.message} Die Grundprüfung kann je nach Gerät länger dauern. Zusätzlicher Denkmodus bei Bedarf: bis zu ${announcedSeconds} Sekunden.`
        : `${state.message} Zusätzliche Denkzeit: noch ${announcedSeconds} Sekunden.`,
    )
  } else {
    status?.removeAttribute("aria-label")
  }
  countdownText(element, state)
}

export function showActivity(
  id: string,
  runId: string,
  phase: EvaluationProgressPhase | "",
  options: ActivityDisplayOptions = {},
): void {
  const normalizedId = id.trim()
  const normalizedRunId = runId.trim()
  if (!normalizedId) throw new Error("Die Aktivitäts-ID darf nicht leer sein.")
  if (!normalizedRunId) throw new Error("Die Lauf-ID darf nicht leer sein.")

  if (phase) {
    const current = activityById.get(normalizedId)
    if (
      current &&
      current.runId !== normalizedRunId &&
      phase !== "selecting-model"
    ) {
      return
    }
    if (
      current?.runId !== normalizedRunId &&
      retiredRunsById.get(normalizedId)?.has(normalizedRunId)
    ) {
      return
    }
    if (current && current.runId !== normalizedRunId) {
      retireRun(normalizedId, current.runId)
    }
    stopActivityCountdown(normalizedId)
    const thinkingTimeLimitMs = positiveMilliseconds(
      options.thinkingTimeLimitMs,
    )
    const thinkingTimeRemainingMs = positiveMilliseconds(
      options.thinkingTimeRemainingMs,
    )
    const state: ActivityState = {
      runId: normalizedRunId,
      phase,
      message: options.message?.trim() || ACTIVITY_MESSAGES[phase],
      thinkingTimeLimitMs,
    }
    const onCancel =
      options.onCancel ??
      (current?.runId === normalizedRunId ? current.onCancel : undefined)
    if (onCancel) state.onCancel = onCancel
    if (current?.runId === normalizedRunId && current.cancelRequested) {
      state.cancelRequested = true
    }
    if (thinkingTimeRemainingMs !== undefined) {
      state.thinkingTimeInitialMs = thinkingTimeRemainingMs
      state.thinkingDeadlineMs = Date.now() + thinkingTimeRemainingMs
    }
    activityById.set(normalizedId, state)
  } else {
    const current = activityById.get(normalizedId)
    if (!current || current.runId !== normalizedRunId) return
    stopActivityCountdown(normalizedId)
    retireRun(normalizedId, normalizedRunId)
    activityById.delete(normalizedId)
  }

  if (typeof document === "undefined") return
  const element = document.getElementById(normalizedId)
  if (element?.tagName.toLowerCase() === "lia-llm-activity") {
    const state = activityById.get(normalizedId)
    renderActivity(element, state)
    if (state) scheduleActivityCountdown(element, state)
  }
}

export function registerActivityElement(): void {
  if (
    typeof customElements === "undefined" ||
    typeof HTMLElement === "undefined" ||
    customElements.get("lia-llm-activity")
  ) {
    return
  }

  class LiaLLMActivityElement extends HTMLElement {
    connectedCallback(): void {
      this.setAttribute("role", "group")
      this.setAttribute("aria-label", "Lokale Antwortauswertung")
      this.style.width = "min(22rem, 100%)"
      this.style.margin = ".35rem 0 .15rem auto"
      this.style.gap = ".25rem"
      ensureActivityShadow(this)
      const state = activityById.get(this.id)
      renderActivity(this, state)
      if (state) scheduleActivityCountdown(this, state)
    }

    disconnectedCallback(): void {
      stopActivityCountdown(this.id)
      const state = activityById.get(this.id)
      if (state) retireRun(this.id, state.runId)
      activityById.delete(this.id)
      this.hidden = true
      this.style.display = "none"
    }
  }

  customElements.define("lia-llm-activity", LiaLLMActivityElement)
}
