const SELECTOR = '[data-llm-textarea] input.lia-quiz__input'
const DEFAULT_ROWS = 5
const MIN_ROWS = 2
const MAX_ROWS = 12
const NATIVE_LINE_BREAK = "\u2028"

interface TextareaProxy {
  area: HTMLTextAreaElement
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

function copyAriaAttribute(
  input: HTMLInputElement,
  area: HTMLTextAreaElement,
  name: string,
): void {
  const value = input.getAttribute(name)
  if (value === null) area.removeAttribute(name)
  else area.setAttribute(name, value)
}

function syncPresentation(input: HTMLInputElement, proxy: TextareaProxy): void {
  const { area } = proxy
  if (area.disabled !== input.disabled) area.disabled = input.disabled

  const className = `${input.className} lia-llm-textarea`.trim()
  if (area.className !== className) area.className = className
  copyAriaAttribute(input, area, "aria-describedby")
  copyAriaAttribute(input, area, "aria-labelledby")

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

function enhance(input: HTMLInputElement): void {
  const current = proxies.get(input)
  if (current?.area.isConnected) {
    syncPresentation(input, current)
    return
  }
  if (current) removeProxy(input, current)

  const owner = input.closest<HTMLElement>("[data-llm-textarea]")
  if (!owner || !isEnabled(owner)) return

  const area = document.createElement("textarea")
  const hadFocus = document.activeElement === input
  area.rows = parseTextareaRows(owner.getAttribute("data-llm-textarea"))
  area.maxLength = 8_000
  area.value = fromQuizInputValue(input.value)
  area.placeholder =
    owner.getAttribute("data-llm-placeholder") ?? input.placeholder ?? "Antwort eingeben …"
  area.spellcheck = true
  area.wrap = "soft"
  area.setAttribute("aria-label", input.getAttribute("aria-label") ?? "Quizantwort")
  area.setAttribute("data-lia-llm-textarea", "")
  area.style.setProperty("display", "block")
  area.style.setProperty("box-sizing", "border-box")
  area.style.setProperty("width", "100%")
  area.style.setProperty("height", "auto", "important")
  area.style.setProperty("min-height", "0", "important")
  area.style.setProperty("resize", "vertical")
  area.style.setProperty("font", "inherit")
  area.style.setProperty("line-height", "1.45")

  const proxy: TextareaProxy = {
    area,
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
  input.after(area)
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
    const owner = input.closest<HTMLElement>("[data-llm-textarea]")
    if (
      !input.isConnected ||
      !proxy.area.isConnected ||
      !input.matches(SELECTOR) ||
      !owner ||
      !isEnabled(owner)
    ) {
      removeProxy(input, proxy)
    } else {
      proxy.area.rows = parseTextareaRows(owner.getAttribute("data-llm-textarea"))
      syncPresentation(input, proxy)
    }
  }

  document.querySelectorAll<HTMLInputElement>(SELECTOR).forEach(enhance)
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

        if (mutation.target instanceof HTMLInputElement) {
          const proxy = proxies.get(mutation.target)
          if (proxy) syncPresentation(mutation.target, proxy)
          if (proxy || mutation.target.matches(SELECTOR)) shouldReconcile = true
          continue
        }

        if (
          mutation.attributeName === "data-llm-textarea" &&
          mutation.target instanceof HTMLElement
        ) {
          shouldReconcile = true
        }
      }

      if (shouldReconcile) scheduleReconciliation()
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "disabled", "value", "data-llm-textarea"],
    })
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true })
  } else {
    start()
  }
}
