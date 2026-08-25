import type {
  FeedbackDisplayOptions,
  FeedbackLanguageCheckRequest,
  FeedbackLanguageCheckResult,
  OrthographyCorrection,
  OrthographyCorrectionKind,
} from "./types.ts"

type LanguageCheckPhase = "idle" | "loading" | "completed" | "retry"

interface FeedbackState {
  message: string
  orthographyCorrection?: OrthographyCorrection
  languageCheck?: FeedbackLanguageCheckRequest
  languageCheckPhase: LanguageCheckPhase
  languageCheckMessage: string
  requestSequence: number
  controller?: AbortController
  owner?: HTMLElement
}

interface FeedbackShadow {
  content: HTMLElement
  action: HTMLButtonElement
  languageStatus: HTMLElement
  toggle: HTMLButtonElement
  panel: HTMLElement
}

const feedbackById = new Map<string, FeedbackState>()
const correctionByElement = new WeakMap<HTMLElement, OrthographyCorrection>()
const FEEDBACK_LAYOUT_STYLE_ID = "lia-llm-feedback-layout"
const FEEDBACK_CONTENT_CLASS = "lia-llm-feedback-content"
const FEEDBACK_ACTION_CLASS = "lia-llm-feedback-language-action"
const FEEDBACK_LANGUAGE_STATUS_CLASS = "lia-llm-feedback-language-status"
const FEEDBACK_TOGGLE_CLASS = "lia-llm-feedback-correction-toggle"
const FEEDBACK_PANEL_CLASS = "lia-llm-feedback-correction-panel"
const CORRECTION_MARK_CLASS = "lia-llm-feedback-correction-mark"
const CORRECTION_REMOVAL_CLASS = "lia-llm-feedback-correction-removal"
const COLLAPSED_LABEL = "Korrigierten Text anzeigen"
const EXPANDED_LABEL = "Korrigierten Text ausblenden"

function emptyFeedbackState(): FeedbackState {
  return {
    message: "",
    languageCheckPhase: "idle",
    languageCheckMessage: "",
    requestSequence: 0,
  }
}

function registerFeedbackLayoutStyles(): void {
  if (
    typeof document === "undefined" ||
    document.getElementById(FEEDBACK_LAYOUT_STYLE_ID)
  ) {
    return
  }
  const style = document.createElement("style")
  style.id = FEEDBACK_LAYOUT_STYLE_ID
  style.textContent = `
.lia-quiz[data-llm-textarea] {
  margin-block-end: 0;
}
.lia-quiz[data-llm-textarea] > .lia-quiz__hints:empty {
  display: none;
}
`
  document.head.append(style)
}

function isCorrectionKind(value: unknown): value is OrthographyCorrectionKind {
  return (
    value === "spelling" ||
    value === "punctuation" ||
    value === "grammar"
  )
}

function normalizedCorrection(
  value: OrthographyCorrection | undefined,
): OrthographyCorrection | undefined {
  if (!value || !Array.isArray(value.parts)) return undefined

  const parts: OrthographyCorrection["parts"] = []
  for (const part of value.parts) {
    if (
      !part ||
      typeof part.text !== "string" ||
      typeof part.changed !== "boolean"
    ) {
      return undefined
    }
    if (part.changed) {
      if (
        !isCorrectionKind(part.kind) ||
        (part.removedText !== undefined &&
          typeof part.removedText !== "string")
      ) {
        return undefined
      }
      parts.push({
        text: part.text,
        changed: true,
        kind: part.kind,
        ...(part.removedText !== undefined
          ? { removedText: part.removedText }
          : {}),
      })
    } else {
      if (part.kind !== undefined || part.removedText !== undefined) {
        return undefined
      }
      parts.push({ text: part.text, changed: false })
    }
  }

  const hasContent = parts.some(
    (part) =>
      part.text.length > 0 || (part.removedText?.length ?? 0) > 0,
  )
  return hasContent ? { parts } : undefined
}

function normalizedLanguageCheck(
  value: FeedbackLanguageCheckRequest | undefined,
): FeedbackLanguageCheckRequest | undefined {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.runId !== "string" ||
    !value.runId.trim() ||
    (value.kind !== "orthography" &&
      value.kind !== "syntax" &&
      value.kind !== "language") ||
    typeof value.run !== "function"
  ) {
    throw new Error("languageCheck benötigt runId, kind und eine run-Funktion.")
  }
  return {
    runId: value.runId.trim(),
    kind: value.kind,
    run: value.run,
  }
}

function normalizedLanguageCheckResult(
  value: FeedbackLanguageCheckResult,
  kind: FeedbackLanguageCheckRequest["kind"],
): FeedbackLanguageCheckResult {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.message !== "string" ||
    typeof value.completed !== "boolean"
  ) {
    throw new Error("Die Sprachprüfung hat kein gültiges UI-Ergebnis geliefert.")
  }
  if (!value.completed && value.orthographyCorrection !== undefined) {
    throw new Error("Eine unvollständige Sprachprüfung darf keine Korrektur liefern.")
  }
  const correction = normalizedCorrection(value.orthographyCorrection)
  if (value.orthographyCorrection !== undefined && !correction) {
    throw new Error("Die Sprachprüfung hat keine gültige Korrektur geliefert.")
  }
  const hasMismatchedCorrectionKind = correction?.parts.some((part) => {
    if (!part.changed) return false
    if (!part.kind) return true
    if (kind === "orthography") return part.kind === "grammar"
    if (kind === "syntax") return part.kind !== "grammar"
    return false
  })
  if (hasMismatchedCorrectionKind) {
    throw new Error(
      "Die Sprachprüfung hat eine Korrektur aus der falschen Kategorie geliefert.",
    )
  }
  return {
    message: value.message,
    completed: value.completed,
    ...(correction ? { orthographyCorrection: correction } : {}),
  }
}

function abortFeedbackState(state: FeedbackState): void {
  state.requestSequence += 1
  state.controller?.abort()
  state.controller = undefined
}

function initialActionLabel(kind: FeedbackLanguageCheckRequest["kind"]): string {
  if (kind === "orthography") return "Rechtschreibung prüfen"
  if (kind === "syntax") return "Grammatik und Satzbau prüfen"
  return "Sprache prüfen"
}

function loadingActionLabel(kind: FeedbackLanguageCheckRequest["kind"]): string {
  if (kind === "orthography") return "Rechtschreibung wird geprüft …"
  if (kind === "syntax") return "Grammatik und Satzbau werden geprüft …"
  return "Sprache wird geprüft …"
}

function loadingStatus(kind: FeedbackLanguageCheckRequest["kind"]): string {
  if (kind === "orthography") {
    return "Rechtschreibung und Zeichensetzung werden geprüft …"
  }
  if (kind === "syntax") return "Grammatik und Satzbau werden geprüft …"
  return "Rechtschreibung, Zeichensetzung, Grammatik und Satzbau werden geprüft …"
}

function failureStatus(kind: FeedbackLanguageCheckRequest["kind"]): string {
  if (kind === "orthography") {
    return "Die Rechtschreibprüfung ist derzeit nicht verfügbar."
  }
  if (kind === "syntax") {
    return "Die Grammatik- und Satzbauprüfung ist derzeit nicht verfügbar."
  }
  return "Die Sprachprüfung ist derzeit nicht verfügbar."
}

function renderCorrection(
  panel: HTMLElement,
  correction: OrthographyCorrection,
): void {
  const fragment = panel.ownerDocument.createDocumentFragment()
  for (const part of correction.parts) {
    if (!part.changed) {
      fragment.append(panel.ownerDocument.createTextNode(part.text))
      continue
    }

    const mark = panel.ownerDocument.createElement("mark")
    mark.className = CORRECTION_MARK_CLASS
    if (part.kind) mark.dataset.kind = part.kind
    mark.textContent = part.text
    if (part.text.length === 0 && part.removedText) {
      mark.classList.add(CORRECTION_REMOVAL_CLASS)
      mark.setAttribute("aria-label", "Entfernte Textstelle")
    }
    fragment.append(mark)
  }
  panel.replaceChildren(fragment)
}

function setExpanded(
  element: HTMLElement,
  shadow: FeedbackShadow,
  expanded: boolean,
): void {
  const correction = correctionByElement.get(element)
  const nextExpanded = expanded && correction !== undefined
  if (nextExpanded && !shadow.panel.hasChildNodes()) {
    renderCorrection(shadow.panel, correction)
  }
  shadow.toggle.setAttribute("aria-expanded", String(nextExpanded))
  shadow.toggle.textContent = nextExpanded ? EXPANDED_LABEL : COLLAPSED_LABEL
  shadow.panel.hidden = !nextExpanded
}

function ensureFeedbackShadow(element: HTMLElement): FeedbackShadow {
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" })
  const currentContent = shadow.querySelector<HTMLElement>(
    `.${FEEDBACK_CONTENT_CLASS}`,
  )
  const currentAction = shadow.querySelector<HTMLButtonElement>(
    `.${FEEDBACK_ACTION_CLASS}`,
  )
  const currentLanguageStatus = shadow.querySelector<HTMLElement>(
    `.${FEEDBACK_LANGUAGE_STATUS_CLASS}`,
  )
  const currentToggle = shadow.querySelector<HTMLButtonElement>(
    `.${FEEDBACK_TOGGLE_CLASS}`,
  )
  const currentPanel = shadow.querySelector<HTMLElement>(
    `.${FEEDBACK_PANEL_CLASS}`,
  )
  if (
    currentContent &&
    currentAction &&
    currentLanguageStatus &&
    currentToggle &&
    currentPanel
  ) {
    return {
      content: currentContent,
      action: currentAction,
      languageStatus: currentLanguageStatus,
      toggle: currentToggle,
      panel: currentPanel,
    }
  }

  shadow.replaceChildren()
  const style = element.ownerDocument.createElement("style")
  style.textContent = `
:host {
  display: block;
}
.${FEEDBACK_CONTENT_CLASS} {
  display: block;
  white-space: pre-line;
}
.${FEEDBACK_ACTION_CLASS},
.${FEEDBACK_TOGGLE_CLASS} {
  display: block;
  margin-block-start: .65rem;
  padding: .45rem .75rem;
  border: 1px solid currentColor;
  border-radius: .25rem;
  color: rgb(var(--color-highlight, 0, 145, 154));
  background: transparent;
  font: inherit;
  font-weight: 600;
  line-height: 1.35;
  cursor: pointer;
}
.${FEEDBACK_ACTION_CLASS}:hover:not(:disabled),
.${FEEDBACK_TOGGLE_CLASS}:hover {
  text-decoration: underline;
}
.${FEEDBACK_ACTION_CLASS}:focus-visible,
.${FEEDBACK_TOGGLE_CLASS}:focus-visible {
  outline: 2px solid rgb(var(--color-highlight, 0, 145, 154));
  outline-offset: 3px;
}
.${FEEDBACK_ACTION_CLASS}:disabled {
  cursor: wait;
  opacity: .72;
}
.${FEEDBACK_LANGUAGE_STATUS_CLASS} {
  display: block;
  margin-block-start: .55rem;
  font-weight: 400;
  white-space: pre-line;
}
.${FEEDBACK_ACTION_CLASS}[hidden],
.${FEEDBACK_LANGUAGE_STATUS_CLASS}[hidden],
.${FEEDBACK_TOGGLE_CLASS}[hidden],
.${FEEDBACK_PANEL_CLASS}[hidden] {
  display: none;
}
.${FEEDBACK_PANEL_CLASS} {
  margin-block-start: .65rem;
  padding: .75rem;
  border-inline-start: 3px solid rgb(var(--color-highlight, 0, 145, 154));
  color: rgb(var(--color-text, 75, 75, 75));
  font-weight: 400;
  line-height: 1.5;
  white-space: pre-wrap;
}
.${CORRECTION_MARK_CLASS} {
  color: rgb(var(--color-highlight, 0, 145, 154));
  background: transparent;
  font-weight: 700;
  text-decoration-line: underline;
  text-decoration-color: rgb(var(--color-highlight, 0, 145, 154));
  text-decoration-thickness: .12em;
  text-underline-offset: .14em;
}
.${CORRECTION_REMOVAL_CLASS}::after {
  content: "−";
  display: inline-block;
  min-inline-size: .65em;
  text-align: center;
}
@media (forced-colors: active) {
  .${FEEDBACK_ACTION_CLASS}:focus-visible,
  .${FEEDBACK_TOGGLE_CLASS}:focus-visible {
    outline-color: Highlight;
  }
  .${FEEDBACK_PANEL_CLASS} {
    border-inline-start-color: Highlight;
  }
  .${CORRECTION_MARK_CLASS} {
    color: Highlight;
    text-decoration-color: Highlight;
  }
}
`

  const content = element.ownerDocument.createElement("span")
  content.className = FEEDBACK_CONTENT_CLASS
  content.setAttribute("part", "content")
  content.setAttribute("role", "status")
  content.setAttribute("aria-live", "polite")
  content.setAttribute("aria-atomic", "true")

  const action = element.ownerDocument.createElement("button")
  action.type = "button"
  action.className = FEEDBACK_ACTION_CLASS
  action.id = "language-check-action"
  action.setAttribute("part", "language-action")
  action.setAttribute("aria-describedby", "language-check-status")
  action.setAttribute("aria-busy", "false")
  action.hidden = true

  const languageStatus = element.ownerDocument.createElement("span")
  languageStatus.className = FEEDBACK_LANGUAGE_STATUS_CLASS
  languageStatus.id = "language-check-status"
  languageStatus.setAttribute("part", "language-status")
  languageStatus.setAttribute("role", "status")
  languageStatus.setAttribute("aria-live", "polite")
  languageStatus.setAttribute("aria-atomic", "true")
  languageStatus.hidden = true

  const toggle = element.ownerDocument.createElement("button")
  toggle.type = "button"
  toggle.className = FEEDBACK_TOGGLE_CLASS
  toggle.id = "orthography-correction-toggle"
  toggle.setAttribute("part", "correction-toggle")
  toggle.setAttribute("aria-controls", "orthography-correction-panel")
  toggle.setAttribute("aria-expanded", "false")
  toggle.textContent = COLLAPSED_LABEL
  toggle.hidden = true

  const panel = element.ownerDocument.createElement("div")
  panel.className = FEEDBACK_PANEL_CLASS
  panel.id = "orthography-correction-panel"
  panel.setAttribute("part", "correction-panel")
  panel.setAttribute("role", "region")
  panel.setAttribute(
    "aria-label",
    "Korrigierter Text. Unterstrichene Stellen markieren Rechtschreib-, Zeichensetzungs- oder Grammatikkorrekturen; ein Minuszeichen kennzeichnet eine Entfernung.",
  )
  panel.hidden = true

  const result = { content, action, languageStatus, toggle, panel }
  action.addEventListener("click", () => {
    const state = feedbackById.get(element.id.trim())
    if (state) startLanguageCheck(element, state)
  })
  toggle.addEventListener("click", () => {
    setExpanded(
      element,
      result,
      toggle.getAttribute("aria-expanded") !== "true",
    )
  })
  shadow.append(style, content, action, languageStatus, toggle, panel)
  return result
}

function isCurrentLanguageCheck(
  element: HTMLElement,
  state: FeedbackState,
  request: FeedbackLanguageCheckRequest,
  sequence: number,
  signal: AbortSignal,
): boolean {
  return (
    !signal.aborted &&
    element.isConnected &&
    state.owner === element &&
    feedbackById.get(element.id.trim()) === state &&
    state.languageCheck?.runId === request.runId &&
    state.requestSequence === sequence
  )
}

function startLanguageCheck(
  element: HTMLElement,
  state: FeedbackState,
): void {
  const request = state.languageCheck
  if (
    !request ||
    feedbackById.get(element.id.trim()) !== state ||
    state.owner !== element ||
    (state.languageCheckPhase !== "idle" &&
      state.languageCheckPhase !== "retry") ||
    state.controller
  ) {
    return
  }

  const controller = new AbortController()
  const sequence = state.requestSequence + 1
  state.requestSequence = sequence
  state.controller = controller
  state.languageCheckPhase = "loading"
  state.languageCheckMessage = ""
  state.orthographyCorrection = undefined
  renderFeedback(element, state)

  void Promise.resolve()
    .then(() => request.run(controller.signal))
    .then((rawResult) => {
      if (
        !isCurrentLanguageCheck(
          element,
          state,
          request,
          sequence,
          controller.signal,
        )
      ) {
        return
      }
      const result = normalizedLanguageCheckResult(rawResult, request.kind)
      state.controller = undefined
      state.message = result.message
      if (result.completed) {
        state.languageCheckPhase = "completed"
        state.languageCheckMessage = ""
        state.orthographyCorrection = result.orthographyCorrection
      } else {
        state.languageCheckPhase = "retry"
        state.languageCheckMessage = failureStatus(request.kind)
      }
      renderFeedback(element, state)
    })
    .catch(() => {
      if (
        !isCurrentLanguageCheck(
          element,
          state,
          request,
          sequence,
          controller.signal,
        )
      ) {
        return
      }
      state.controller = undefined
      state.languageCheckPhase = "retry"
      state.languageCheckMessage = failureStatus(request.kind)
      state.orthographyCorrection = undefined
      renderFeedback(element, state)
    })
}

function renderFeedback(element: HTMLElement, state: FeedbackState): void {
  const shadow = ensureFeedbackShadow(element)
  state.owner = element
  shadow.content.textContent = state.message
  shadow.action.hidden = true
  shadow.action.disabled = false
  shadow.action.setAttribute("aria-busy", "false")
  shadow.action.textContent = ""
  shadow.languageStatus.textContent = ""
  shadow.languageStatus.hidden = true
  shadow.panel.replaceChildren()
  shadow.toggle.hidden = true
  correctionByElement.delete(element)
  setExpanded(element, shadow, false)

  const request = state.languageCheck
  const directCorrection = request
    ? undefined
    : state.orthographyCorrection
  if (directCorrection) {
    correctionByElement.set(element, directCorrection)
    shadow.toggle.hidden = false
  } else if (request) {
    if (state.languageCheckPhase === "idle") {
      shadow.action.textContent = initialActionLabel(request.kind)
      shadow.action.hidden = false
    } else if (state.languageCheckPhase === "loading") {
      shadow.action.textContent = loadingActionLabel(request.kind)
      shadow.action.hidden = false
      shadow.action.disabled = true
      shadow.action.setAttribute("aria-busy", "true")
      shadow.languageStatus.textContent = loadingStatus(request.kind)
      shadow.languageStatus.hidden = false
    } else if (state.languageCheckPhase === "retry") {
      shadow.action.textContent = "Erneut versuchen"
      shadow.action.hidden = false
      shadow.languageStatus.textContent =
        state.languageCheckMessage || failureStatus(request.kind)
      shadow.languageStatus.hidden = false
    } else {
      shadow.languageStatus.textContent = state.languageCheckMessage
      shadow.languageStatus.hidden = state.languageCheckMessage.length === 0
      if (state.orthographyCorrection) {
        correctionByElement.set(element, state.orthographyCorrection)
        shadow.toggle.hidden = false
        setExpanded(element, shadow, true)
      }
    }
  }

  element.hidden =
    state.message.length === 0 &&
    shadow.action.hidden &&
    shadow.languageStatus.hidden &&
    shadow.toggle.hidden
}

export function showFeedback(
  id: string,
  message: string,
  options?: FeedbackDisplayOptions,
): void {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error("Die Feedback-ID darf nicht leer sein.")

  const nextCorrection = message.length > 0
    ? normalizedCorrection(options?.orthographyCorrection)
    : undefined
  const nextLanguageCheck = normalizedLanguageCheck(options?.languageCheck)
  const hasFeedback = message.length > 0 || nextLanguageCheck !== undefined
  const state: FeedbackState = hasFeedback
    ? {
        message,
        orthographyCorrection: nextCorrection,
        languageCheck: nextLanguageCheck,
        languageCheckPhase: "idle",
        languageCheckMessage: "",
        requestSequence: 0,
      }
    : emptyFeedbackState()

  const previous = feedbackById.get(normalizedId)
  if (previous) abortFeedbackState(previous)
  if (hasFeedback) feedbackById.set(normalizedId, state)
  else feedbackById.delete(normalizedId)

  if (typeof document === "undefined") return
  const element = document.getElementById(normalizedId)
  if (element?.tagName.toLowerCase() === "lia-llm-feedback") {
    renderFeedback(element, state)
  }
}

export function registerFeedbackElement(): void {
  registerFeedbackLayoutStyles()
  if (
    typeof customElements === "undefined" ||
    typeof HTMLElement === "undefined" ||
    customElements.get("lia-llm-feedback")
  ) {
    return
  }

  class LiaLLMFeedbackElement extends HTMLElement {
    connectedCallback(): void {
      this.removeAttribute("role")
      this.removeAttribute("aria-live")
      this.removeAttribute("aria-atomic")
      this.classList.add("lia-link")
      this.style.display = "block"
      this.style.marginBlockStart = ".75rem"
      this.style.fontWeight = "600"
      this.style.whiteSpace = "pre-line"
      ensureFeedbackShadow(this)
      renderFeedback(
        this,
        feedbackById.get(this.id.trim()) ?? emptyFeedbackState(),
      )
    }

    disconnectedCallback(): void {
      const id = this.id.trim()
      const state = feedbackById.get(id)
      if (state?.owner === this) {
        feedbackById.delete(id)
        abortFeedbackState(state)
      }
      correctionByElement.delete(this)
    }
  }

  customElements.define("lia-llm-feedback", LiaLLMFeedbackElement)
}
