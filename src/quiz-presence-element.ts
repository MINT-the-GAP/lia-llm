let preparationClaimed = false

export function registerQuizPresenceElement(
  onFirstQuizDetected: () => void,
  onQuizDisconnected?: (id: string) => void,
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

    disconnectedCallback(): void {
      // Elm may move an existing node while updating a quiz. Only retire a
      // session if its host is still detached after that synchronous update.
      queueMicrotask(() => {
        if (
          !this.isConnected &&
          !this.ownerDocument.getElementById(this.id) &&
          this.id.startsWith("lia-llm-quiz-")
        ) {
          onQuizDisconnected?.(this.id.slice("lia-llm-quiz-".length))
        }
      })
    }
  }

  customElements.define("lia-llm-quiz-use", LiaLLMQuizUseElement)
}
