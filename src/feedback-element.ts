const feedbackById = new Map<string, string>()

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
      this.style.display = "block"
      this.style.marginTop = ".55rem"
      this.style.fontWeight = "600"
      renderFeedback(this, feedbackById.get(this.id) ?? "")
    }
  }

  customElements.define("lia-llm-feedback", LiaLLMFeedbackElement)
}
