const solutionById = new Map<string, string>()

function renderSolution(element: HTMLElement, text: string): void {
  element.textContent = text
  const visible = text.length > 0
  element.hidden = !visible
  element.style.display = visible ? "block" : "none"
}

export function showSolution(id: string, text: string): void {
  const normalizedId = id.trim()
  if (!normalizedId) throw new Error("Die Lösungs-ID darf nicht leer sein.")

  if (text) solutionById.set(normalizedId, text)
  else solutionById.delete(normalizedId)

  if (typeof document === "undefined") return
  const element = document.getElementById(normalizedId)
  if (element?.tagName.toLowerCase() === "lia-llm-solution") {
    renderSolution(element, text)
  }
}

export function registerSolutionElement(): void {
  if (
    typeof customElements === "undefined" ||
    typeof HTMLElement === "undefined" ||
    customElements.get("lia-llm-solution")
  ) {
    return
  }

  class LiaLLMSolutionElement extends HTMLElement {
    connectedCallback(): void {
      this.style.whiteSpace = "pre-wrap"
      renderSolution(this, solutionById.get(this.id) ?? "")
    }
  }

  customElements.define("lia-llm-solution", LiaLLMSolutionElement)
}
