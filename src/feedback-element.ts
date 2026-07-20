const feedbackById = new Map<string, string>()

export function showFeedback(id: string, html: string): void {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error("Die Feedback-ID darf nicht leer sein.")

  if (html) feedbackById.set(normalizedId, html)
  else feedbackById.delete(normalizedId)

  if (typeof document === "undefined") return
  const element = document.getElementById(normalizedId)
  if (element?.tagName.toLowerCase() === "lia-llm-feedback") {
    element.innerHTML = html
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
      this.style.display = "block"
      const html = feedbackById.get(this.id)
      if (html !== undefined) this.innerHTML = html
    }
  }

  customElements.define("lia-llm-feedback", LiaLLMFeedbackElement)
}
