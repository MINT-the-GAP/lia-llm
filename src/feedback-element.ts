const feedbackById = new Map<string, string>()
const FEEDBACK_LAYOUT_STYLE_ID = "lia-llm-feedback-layout"

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

function renderFeedback(element: HTMLElement, message: string): void {
  element.textContent = message
  element.hidden = !message
}

export function showFeedback(id: string, message: string): void {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error("Die Feedback-ID darf nicht leer sein.")

  if (message) feedbackById.set(normalizedId, message)
  else feedbackById.delete(normalizedId)

  if (typeof document === "undefined") return
  const element = document.getElementById(normalizedId)
  if (element?.tagName.toLowerCase() === "lia-llm-feedback") {
    renderFeedback(element, message)
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
      this.setAttribute("role", "status")
      this.setAttribute("aria-live", "polite")
      this.classList.add("lia-link")
      this.style.display = "block"
      this.style.marginBlockStart = ".75rem"
      this.style.fontWeight = "600"
      this.style.whiteSpace = "pre-line"
      renderFeedback(this, feedbackById.get(this.id) ?? "")
    }
  }

  customElements.define("lia-llm-feedback", LiaLLMFeedbackElement)
}
