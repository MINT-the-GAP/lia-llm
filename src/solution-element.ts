const solutionById = new Map<string, string>()
interface SolutionVariantState {
  runId: string
  index?: number
}

const solutionVariantById = new Map<string, SolutionVariantState>()
const SOLUTION_CONTENT_CLASS = "lia-llm-solution-content"

function normalizedIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} darf nicht leer sein.`)
  return normalized
}

/**
 * Starts a solution-selection run when `index` is omitted. An index can only
 * be recorded by the run that is currently active for the solution ID.
 */
export function setSolutionVariant(
  id: string,
  runId: string,
  index?: number,
): void {
  const normalizedId = normalizedIdentifier(id, "Die Lösungs-ID")
  const normalizedRunId = normalizedIdentifier(runId, "Die Lauf-ID")
  if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
    throw new Error("Der Lösungsvariantenindex muss eine nicht negative ganze Zahl sein.")
  }

  if (index === undefined) {
    solutionVariantById.set(normalizedId, { runId: normalizedRunId })
    return
  }

  const current = solutionVariantById.get(normalizedId)
  if (current?.runId !== normalizedRunId) return
  solutionVariantById.set(normalizedId, {
    runId: normalizedRunId,
    index,
  })
}

export function getSolutionVariant(id: string): number | undefined {
  const normalizedId = normalizedIdentifier(id, "Die Lösungs-ID")
  return solutionVariantById.get(normalizedId)?.index
}

export function clearSolutionVariant(id: string, runId: string): void {
  const normalizedId = normalizedIdentifier(id, "Die Lösungs-ID")
  const normalizedRunId = normalizedIdentifier(runId, "Die Lauf-ID")
  if (solutionVariantById.get(normalizedId)?.runId === normalizedRunId) {
    solutionVariantById.delete(normalizedId)
  }
}

function ensureSolutionContent(element: HTMLElement): HTMLElement {
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" })
  const current = shadow.querySelector<HTMLElement>(`.${SOLUTION_CONTENT_CLASS}`)
  if (current) return current

  const content = element.ownerDocument.createElement("span")
  content.className = SOLUTION_CONTENT_CLASS
  content.setAttribute("part", "content")
  shadow.append(content)
  return content
}

function renderSolution(element: HTMLElement, text: string): void {
  ensureSolutionContent(element).textContent = text
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
      ensureSolutionContent(this)
      renderSolution(this, solutionById.get(this.id) ?? "")
    }
  }

  customElements.define("lia-llm-solution", LiaLLMSolutionElement)
}

export function registerResultSeparatorElement(): void {
  if (
    typeof customElements === "undefined" ||
    typeof HTMLElement === "undefined" ||
    customElements.get("lia-llm-result-separator")
  ) {
    return
  }

  class LiaLLMResultSeparatorElement extends HTMLElement {
    connectedCallback(): void {
      this.setAttribute("role", "separator")
      this.setAttribute("aria-orientation", "horizontal")
      this.classList.add("lia-link")
      this.style.display = "block"
      this.style.inlineSize = "100%"
      this.style.blockSize = "0"
      this.style.borderBlockStart = "1px solid currentColor"
      this.style.marginBlock = "1rem 1.5rem"
    }
  }

  customElements.define(
    "lia-llm-result-separator",
    LiaLLMResultSeparatorElement,
  )
}
