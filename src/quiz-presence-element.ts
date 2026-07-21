let preparationClaimed = false

export function registerQuizPresenceElement(
  onFirstQuizDetected: () => void,
): void {
  if (
    typeof customElements === "undefined" ||
    typeof HTMLElement === "undefined" ||
    customElements.get("lia-llm-quiz-use")
  ) {
    return
  }

  class LiaLLMQuizUseElement extends HTMLElement {
    connectedCallback(): void {
      this.hidden = true
      this.style.display = "none"
      this.setAttribute("aria-hidden", "true")
      if (preparationClaimed) return
      preparationClaimed = true
      try {
        onFirstQuizDetected()
      } catch {
        // Frühe Modellvorbereitung ist optional und darf das Quiz nie blockieren.
      }
    }
  }

  customElements.define("lia-llm-quiz-use", LiaLLMQuizUseElement)
}
