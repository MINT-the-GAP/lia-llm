const HOST_TAG = "lia-llm-textarea-host"
const HOST_SELECTOR = HOST_TAG
const DEFAULT_ROWS = 5
const MIN_ROWS = 2
const MAX_ROWS = 12
const NATIVE_LINE_BREAK = "\u2028"
const TEXTAREA_DESCRIPTION_ID = "lia-llm-textarea-description"

interface TextareaProxy {
  host: HTMLElement
  area: HTMLTextAreaElement
  description: HTMLSpanElement
  originalStyle: string
  originalAriaHidden: string | null
  originalTabIndex: string | null
  syncing: boolean
  onAreaInput: () => void
  onAreaChange: () => void
  onAreaKeyDown: (event: KeyboardEvent) => void
  onNativeInput: () => void
  onNativeFocus: () => void
}

const proxies = new Map<HTMLInputElement, TextareaProxy>()
let observer: MutationObserver | null = null
let registrationStarted = false
let reconciliationScheduled = false
const globalRegistration = globalThis as typeof globalThis & {
  __liaLlmQuizTextareasRegistered?: boolean
}

export function toQuizInputValue(value: string): string {
  return value.replace(/\r\n?|\n/gu, NATIVE_LINE_BREAK)
}

export function fromQuizInputValue(value: string): string {
  return value.replace(/\u2028/gu, "\n")
}

export function parseTextareaRows(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10)
  if (!Number.isFinite(parsed)) return DEFAULT_ROWS
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, parsed))
}

export function isQuizTextareaNavigationKey(key: string): boolean {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown"
  )
}

function isEnabled(owner: HTMLElement): boolean {
  const value = owner.getAttribute("data-llm-textarea")?.trim().toLowerCase()
  return value !== "false" && value !== "0"
}

function quizForHost(host: HTMLElement): HTMLElement | null {
  const containingQuiz = host.closest<HTMLElement>(".lia-quiz")
  if (containingQuiz) return containingQuiz

  const slide = host.closest<HTMLElement>("main.lia-slide__content")
  if (!slide) return null

  // Macro sidecars can be nested in layout containers such as DynFlex columns.
  // Search each level before ascending so the local quiz takes precedence.
  let current: HTMLElement | null = host
  while (current && current !== slide) {
    let previous = current.previousElementSibling as HTMLElement | null
    while (previous) {
      if (previous.matches(".lia-quiz")) return previous
      const quizzes = previous.querySelectorAll<HTMLElement>(".lia-quiz")
      if (quizzes.length > 0) return quizzes[quizzes.length - 1] ?? null
      previous = previous.previousElementSibling as HTMLElement | null
    }
    current = current.parentElement
  }
  return null
}

function ownerForHost(host: HTMLElement): HTMLElement | null {
  const containingOwner = host.closest<HTMLElement>("[data-llm-textarea]")
  if (containingOwner) return containingOwner
  const quiz = quizForHost(host)
  return quiz?.matches("[data-llm-textarea]") ? quiz : null
}

function inputForHost(host: HTMLElement): HTMLInputElement | null {
  const owner = ownerForHost(host)
  return owner?.querySelector<HTMLInputElement>("input.lia-quiz__input") ?? null
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  if (setter) setter.call(input, value)
  else input.value = value
}

function dispatchInput(input: HTMLInputElement): void {
  try {
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: null,
      }),
    )
  } catch {
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }
}

function normalizedAccessibleText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim()
}

export function parseAriaReferenceIds(value: string | null): string[] {
  return (value ?? "").trim().split(/\s+/u).filter(Boolean)
}

function ariaReferenceText(input: HTMLInputElement, attribute: string): string {
  const ids = parseAriaReferenceIds(input.getAttribute(attribute))
  const texts = ids
    .map((id) =>
      normalizedAccessibleText(input.ownerDocument.getElementById(id)?.textContent),
    )
    .filter(Boolean)
  return [...new Set(texts)].join(" ")
}

function accessibleNameForInput(input: HTMLInputElement): string {
  const referenced = ariaReferenceText(input, "aria-labelledby")
  if (referenced) return referenced

  const direct = normalizedAccessibleText(input.getAttribute("aria-label"))
  if (direct) return direct

  const labels = Array.from(input.labels ?? [], (label) =>
    normalizedAccessibleText(label.textContent),
  ).filter(Boolean)
  return labels.join(" ") || "Quizantwort"
}

function accessibleDescriptionForInput(input: HTMLInputElement): string {
  const texts = [
    ariaReferenceText(input, "aria-describedby"),
    normalizedAccessibleText(input.getAttribute("aria-description")),
  ]
  if (
    input.getAttribute("aria-invalid") === "true" ||
    input.classList.contains("is-failure")
  ) {
    texts.push(ariaReferenceText(input, "aria-errormessage"))
  }
  return [...new Set(texts.filter(Boolean))].join(" ")
}

function syncPresentation(input: HTMLInputElement, proxy: TextareaProxy): void {
  const { area, description } = proxy
  if (area.disabled !== input.disabled) area.disabled = input.disabled
  const owner = ownerForHost(proxy.host)
  const placeholder =
    owner?.getAttribute("data-llm-placeholder") ??
    input.placeholder ??
    "Antwort eingeben …"
  if (area.placeholder !== placeholder) area.placeholder = placeholder

  const className = `${input.className} lia-llm-textarea`.trim()
  if (area.className !== className) area.className = className
  area.setAttribute("aria-label", accessibleNameForInput(input))
  area.removeAttribute("aria-labelledby")

  const descriptionText = accessibleDescriptionForInput(input)
  description.textContent = descriptionText
  if (descriptionText) {
    area.setAttribute("aria-describedby", TEXTAREA_DESCRIPTION_ID)
  } else {
    area.removeAttribute("aria-describedby")
  }
  area.removeAttribute("aria-errormessage")

  const invalid = input.getAttribute("aria-invalid")
  if (invalid !== null) area.setAttribute("aria-invalid", invalid)
  else if (input.classList.contains("is-failure")) area.setAttribute("aria-invalid", "true")
  else area.removeAttribute("aria-invalid")

  if (!proxy.syncing && input.value !== toQuizInputValue(area.value)) {
    area.value = fromQuizInputValue(input.value)
  }
}

function visuallyHide(input: HTMLInputElement): void {
  input.style.setProperty("position", "absolute", "important")
  input.style.setProperty("inline-size", "1px", "important")
  input.style.setProperty("block-size", "1px", "important")
  input.style.setProperty("padding", "0", "important")
  input.style.setProperty("margin", "-1px", "important")
  input.style.setProperty("overflow", "hidden", "important")
  input.style.setProperty("clip", "rect(0, 0, 0, 0)", "important")
  input.style.setProperty("clip-path", "inset(50%)", "important")
  input.style.setProperty("white-space", "nowrap", "important")
  input.style.setProperty("border", "0", "important")
}

function createShadowTextarea(
  host: HTMLElement,
): { area: HTMLTextAreaElement; description: HTMLSpanElement } | null {
  let root = host.shadowRoot
  if (!root) {
    try {
      root = host.attachShadow({ mode: "open" })
    } catch {
      return null
    }
  }

  let style = root.querySelector<HTMLStyleElement>(
    "style[data-lia-llm-textarea-style]",
  )
  if (!style) {
    style = document.createElement("style")
    style.setAttribute("data-lia-llm-textarea-style", "")
    style.textContent = `
:host {
  box-sizing: border-box;
  display: block;
  inline-size: 100%;
}
:host([hidden]) { display: none; }
textarea {
  display: block;
  box-sizing: border-box;
  inline-size: 100%;
  block-size: auto;
  min-block-size: 0;
  resize: vertical;
  border: 1px solid currentColor;
  border-radius: .2rem;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.45;
  padding: .45rem .55rem;
}
textarea:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.lia-llm-textarea-description {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
textarea.is-success:not(.is-failure) {
  border-color: color-mix(in srgb, #00875a 72%, currentColor);
  border-width: 2px;
  box-shadow: inset 4px 0 0 color-mix(in srgb, #00875a 72%, currentColor);
}
textarea.is-failure,
textarea[aria-invalid="true"] {
  border-color: color-mix(in srgb, #d32f2f 76%, currentColor);
  border-width: 2px;
  box-shadow: inset 4px 0 0 color-mix(in srgb, #d32f2f 76%, currentColor);
}
`
    root.prepend(style)
  }

  let description = root.querySelector<HTMLSpanElement>(
    "#" + TEXTAREA_DESCRIPTION_ID,
  )
  if (!description) {
    description = document.createElement("span")
    description.id = TEXTAREA_DESCRIPTION_ID
    description.className = "lia-llm-textarea-description"
    root.append(description)
  }

  let area = root.querySelector<HTMLTextAreaElement>(
    "textarea[data-lia-llm-textarea]",
  )
  if (!area) {
    area = document.createElement("textarea")
    area.setAttribute("data-lia-llm-textarea", "")
    root.append(area)
  }
  return { area, description }
}

function enhance(host: HTMLElement): void {
  const input = inputForHost(host)
  const owner = ownerForHost(host)
  if (!input || !owner || !isEnabled(owner)) {
    host.hidden = true
    return
  }

  const current = proxies.get(input)
  if (current?.host === host && current.area.isConnected) {
    host.hidden = false
    syncPresentation(input, current)
    return
  }
  if (current) removeProxy(input, current)

  const shadowTextarea = createShadowTextarea(host)
  if (!shadowTextarea) return
  const { area, description } = shadowTextarea
  const hadFocus = document.activeElement === input
  area.rows = parseTextareaRows(owner.getAttribute("data-llm-textarea"))
  area.maxLength = 8_000
  area.value = fromQuizInputValue(input.value)
  area.placeholder =
    owner.getAttribute("data-llm-placeholder") ?? input.placeholder ?? "Antwort eingeben …"
  area.spellcheck = true
  area.wrap = "soft"
  area.setAttribute("aria-label", accessibleNameForInput(input))
  const proxy: TextareaProxy = {
    host,
    area,
    description,
    originalStyle: input.style.cssText,
    originalAriaHidden: input.getAttribute("aria-hidden"),
    originalTabIndex: input.getAttribute("tabindex"),
    syncing: false,
    onAreaInput: () => undefined,
    onAreaChange: () => undefined,
    onAreaKeyDown: () => undefined,
    onNativeInput: () => undefined,
    onNativeFocus: () => undefined,
  }

  const syncToNative = (): void => {
    proxy.syncing = true
    try {
      setNativeValue(input, toQuizInputValue(area.value))
      dispatchInput(input)
    } finally {
      proxy.syncing = false
    }
  }

  proxy.onAreaInput = syncToNative
  proxy.onAreaChange = () => {
    syncToNative()
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }
  proxy.onAreaKeyDown = (event) => {
    if (isQuizTextareaNavigationKey(event.key)) event.stopPropagation()
  }
  proxy.onNativeInput = () => {
    if (!proxy.syncing) area.value = fromQuizInputValue(input.value)
  }
  proxy.onNativeFocus = () => area.focus()

  area.addEventListener("input", proxy.onAreaInput)
  area.addEventListener("change", proxy.onAreaChange)
  area.addEventListener("keydown", proxy.onAreaKeyDown)
  input.addEventListener("input", proxy.onNativeInput)
  input.addEventListener("focus", proxy.onNativeFocus)

  visuallyHide(input)
  input.setAttribute("aria-hidden", "true")
  input.setAttribute("tabindex", "-1")

  proxies.set(input, proxy)
  host.hidden = false
  syncPresentation(input, proxy)
  if (hadFocus) area.focus()
}

function removeProxy(input: HTMLInputElement, proxy: TextareaProxy): void {
  proxy.area.removeEventListener("input", proxy.onAreaInput)
  proxy.area.removeEventListener("change", proxy.onAreaChange)
  proxy.area.removeEventListener("keydown", proxy.onAreaKeyDown)
  input.removeEventListener("input", proxy.onNativeInput)
  input.removeEventListener("focus", proxy.onNativeFocus)
  proxy.area.remove()
  proxy.host.hidden = true

  if (input.isConnected) {
    input.style.cssText = proxy.originalStyle
    if (proxy.originalAriaHidden === null) input.removeAttribute("aria-hidden")
    else input.setAttribute("aria-hidden", proxy.originalAriaHidden)
    if (proxy.originalTabIndex === null) input.removeAttribute("tabindex")
    else input.setAttribute("tabindex", proxy.originalTabIndex)
  }

  proxies.delete(input)
}

function reconcile(): void {
  for (const [input, proxy] of [...proxies]) {
    const owner = ownerForHost(proxy.host)
    if (
      !input.isConnected ||
      !proxy.host.isConnected ||
      !proxy.area.isConnected ||
      inputForHost(proxy.host) !== input ||
      !owner ||
      !isEnabled(owner)
    ) {
      removeProxy(input, proxy)
    } else {
      proxy.area.rows = parseTextareaRows(owner.getAttribute("data-llm-textarea"))
      syncPresentation(input, proxy)
    }
  }

  document.querySelectorAll<HTMLElement>(HOST_SELECTOR).forEach(enhance)
}

function scheduleReconciliation(): void {
  if (reconciliationScheduled) return
  reconciliationScheduled = true
  queueMicrotask(() => {
    reconciliationScheduled = false
    reconcile()
  })
}

export function registerQuizTextareas(): void {
  if (
    registrationStarted ||
    globalRegistration.__liaLlmQuizTextareasRegistered ||
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return
  }
  registrationStarted = true
  globalRegistration.__liaLlmQuizTextareasRegistered = true

  if (
    typeof customElements !== "undefined" &&
    typeof HTMLElement !== "undefined" &&
    !customElements.get(HOST_TAG)
  ) {
    class LiaLLMTextareaHostElement extends HTMLElement {
      connectedCallback(): void {
        this.hidden = true
        scheduleReconciliation()
      }

      disconnectedCallback(): void {
        for (const [input, proxy] of proxies) {
          if (proxy.host === this) removeProxy(input, proxy)
        }
      }
    }

    customElements.define(HOST_TAG, LiaLLMTextareaHostElement)
  }

  const start = (): void => {
    if (observer || !document.documentElement) return
    reconcile()
    observer = new MutationObserver((mutations) => {
      let shouldReconcile = false

      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          shouldReconcile = true
          continue
        }
        if (mutation.type === "characterData") {
          shouldReconcile = true
          continue
        }

        if (mutation.target instanceof HTMLInputElement) {
          const proxy = proxies.get(mutation.target)
          if (proxy) syncPresentation(mutation.target, proxy)
          if (proxy || mutation.target.matches("input.lia-quiz__input")) {
            shouldReconcile = true
          }
          continue
        }

        if (
          (mutation.attributeName === "data-llm-textarea" ||
            mutation.attributeName === "data-llm-placeholder") &&
          mutation.target instanceof HTMLElement
        ) {
          shouldReconcile = true
        }
      }

      if (shouldReconcile) scheduleReconciliation()
    })
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-describedby",
        "aria-description",
        "aria-errormessage",
        "aria-invalid",
        "aria-label",
        "aria-labelledby",
        "class",
        "disabled",
        "placeholder",
        "value",
        "data-llm-textarea",
        "data-llm-placeholder",
      ],
    })
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  } else {
    start()
  }
}
