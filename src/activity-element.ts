import type { EvaluationProgressPhase } from "./types.ts"

interface ActivityState {
  runId: string
  phase: EvaluationProgressPhase
}

const activityById = new Map<string, ActivityState>()
const ACTIVITY_MESSAGES: Record<EvaluationProgressPhase, string> = {
  "selecting-model": "Passendes Modell wird ausgewählt …",
  "preparing-compact": "Kompaktmodell wird vorbereitet …",
  "evaluating-compact": "Antwort wird schnell geprüft …",
  "preparing-quality": "Qualitätsprüfung wird vorbereitet …",
  "evaluating-quality": "Antwort wird gründlich geprüft …",
  "fallback-compact": "Prüfung wird mit dem Kompaktmodell abgeschlossen …",
}

const ACTIVITY_SHADOW_STYLE = `
.lia-llm-activity-label {
  font-size: .78em;
  line-height: 1.25;
  text-align: right;
  opacity: .78;
}
.lia-llm-activity-track {
  height: 3px;
  width: 100%;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 16%, transparent);
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
  if (shadow.querySelector(".lia-llm-activity-label")) return shadow

  const ownerDocument = element.ownerDocument
  const style = ownerDocument.createElement("style")
  style.textContent = ACTIVITY_SHADOW_STYLE

  const label = ownerDocument.createElement("span")
  label.className = "lia-llm-activity-label"

  const track = ownerDocument.createElement("span")
  track.className = "lia-llm-activity-track"
  track.setAttribute("role", "progressbar")
  track.setAttribute("aria-label", "Fortschritt der lokalen Antwortauswertung")

  const fill = ownerDocument.createElement("span")
  fill.className = "lia-llm-activity-fill"
  track.append(fill)
  shadow.append(style, label, track)
  return shadow
}

function renderActivity(
  element: HTMLElement,
  state: ActivityState | undefined,
): void {
  const visible = Boolean(state)
  element.hidden = !visible
  element.style.display = visible ? "grid" : "none"
  element.setAttribute("aria-busy", String(visible))

  const shadow = ensureActivityShadow(element)
  const label = shadow.querySelector<HTMLElement>(".lia-llm-activity-label")
  if (label) label.textContent = state ? ACTIVITY_MESSAGES[state.phase] : ""
  const track = shadow.querySelector<HTMLElement>(".lia-llm-activity-track")
  if (track) {
    if (visible) track.setAttribute("aria-valuetext", "Antwort wird ausgewertet")
    else track.removeAttribute("aria-valuetext")
  }
}

export function showActivity(
  id: string,
  runId: string,
  phase: EvaluationProgressPhase | "",
): void {
  const normalizedId = id.trim()
  const normalizedRunId = runId.trim()
  if (!normalizedId) throw new Error("Die Aktivitäts-ID darf nicht leer sein.")
  if (!normalizedRunId) throw new Error("Die Lauf-ID darf nicht leer sein.")

  if (phase) {
    activityById.set(normalizedId, { runId: normalizedRunId, phase })
  } else {
    const current = activityById.get(normalizedId)
    if (!current || current.runId !== normalizedRunId) return
    activityById.delete(normalizedId)
  }

  if (typeof document === "undefined") return
  const element = document.getElementById(normalizedId)
  if (element?.tagName.toLowerCase() === "lia-llm-activity") {
    renderActivity(element, activityById.get(normalizedId))
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
      this.setAttribute("role", "status")
      this.setAttribute("aria-live", "polite")
      this.setAttribute("aria-atomic", "true")
      this.style.width = "min(22rem, 100%)"
      this.style.margin = ".35rem 0 .15rem auto"
      this.style.gap = ".25rem"
      ensureActivityShadow(this)
      renderActivity(this, activityById.get(this.id))
    }

    disconnectedCallback(): void {
      activityById.delete(this.id)
      this.hidden = true
      this.style.display = "none"
      this.setAttribute("aria-busy", "false")
    }
  }

  customElements.define("lia-llm-activity", LiaLLMActivityElement)
}
