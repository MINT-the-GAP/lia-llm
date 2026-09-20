import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, firefox } from "playwright-core"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const viewer = "https://liascript.github.io/course/"
const templateBase = "https://raw.githubusercontent.com/MINT-the-GAP/lia-llm/main/"
const course = "https://raw.githubusercontent.com/MINT-the-GAP/Wochenaufgabe/main/5/Deutsch/Lia5_03.md"
const fixture = templateBase + "test/fixtures/quiz-runtime.md"
const timeout = Number(process.env.LIA_LLM_QUIZ_TIMEOUT_MS || 90_000)
const selected = (process.env.LIA_LLM_QUIZ_BROWSERS || "chromium,firefox").split(",")
const report = { generatedAt: new Date().toISOString(), viewer, course, browsers: [] }

// Only model computation is substituted. Macro expansion, the public viewer,
// runtime control flow, custom elements and feedback formatting stay real.
function installEvaluatorStub() {
  const state = window.__quizRegression = { calls: [], pending: [], preload: 0, language: [], mode: "passed" }
  let runtime
  Object.defineProperty(window, "LiaLLM", {
    configurable: true,
    get: () => runtime,
    set(api) {
      runtime = api
      state.runs = []
      const originalRun = api.runQuiz
      if (originalRun) api.runQuiz = (...args) => { state.runs.push({ id: args[0], answer: args[4] }); return originalRun(...args) }
      const status = state.status = { phase: "ready", assessmentEngine: "compact", loadSource: "cache" }
      api.getStatus = () => status
      api.getCacheInfo = async () => ({ cached: true, modelCached: true, entries: [], size: 0 })
      api.preload = async () => { state.preload += 1; return status }
      const languageAnalysis = {
        status: "completed", spelling: true, syntax: true, wordCount: 12,
        spellingErrors: 1, punctuationErrors: 0, syntaxErrors: 1,
        orthographyCorrection: { parts: [{ text: "Korrigierte Antwort.", changed: true, kind: "spelling" }] },
      }
      api.evaluateLanguage = async (request, options) => {
        state.language.push({ request, hasSignal: options?.signal instanceof AbortSignal })
        return languageAnalysis
      }
      api.evaluate = (request, options = {}) => {
        const entry = { request, engine: request.assessmentEngine, aborted: false, hasSignal: options.signal instanceof AbortSignal }
        state.calls.push(entry)
        options.signal?.addEventListener("abort", () => { entry.aborted = true })
        options.onProgress?.({ phase: "evaluating-compact", engine: "compact", message: "Regression: Inhalt wird geprüft." })
        const result = mode => ({
          status: mode, passed: mode === "passed", mode: "holistic", coverage: mode === "passed" ? 1 : 0,
          potentialCoverage: mode === "passed" ? 1 : 0, criteria: [], answer: request.answer,
          selectedReferenceIndex: 1, durationMs: 1,
          model: { id: "browser-regression-stub", revision: "1", device: "none", dtype: "none", task: "deterministic-match" },
          notice: "", languageAnalysis: request.languageAnalysis ? languageAnalysis : undefined,
        })
        if (state.mode === "error") return Promise.reject(new Error("Regression: technischer Fehler"))
        if (state.mode === "pending") {
          // Intentionally ignores abort when resolving; late results must also be discarded.
          return new Promise(resolve => state.pending.push(mode => resolve(result(mode))))
        }
        return Promise.resolve(result(state.mode))
      }
    },
  })
}

async function runInteractions(page, result) {
  result.interactions = []
  const record = name => { result.interactions.push(name); console.log("  PASS " + name) }
  const input = index => page.locator(".lia-quiz__input").nth(index)
  const check = index => page.locator(".lia-quiz__check").nth(index)
  const feedback = index => page.locator("lia-llm-feedback").nth(index)
  const activity = index => page.locator("lia-llm-activity").nth(index)
  const start = async (index, mode, keyboard = false) => {
    const count = await page.evaluate(() => window.__quizRegression.calls.length)
    await page.evaluate(value => { window.__quizRegression.mode = value }, mode)
    await page.locator("lia-llm-textarea-host textarea").nth(index).fill("Eine ausfuehrliche Antwort.\nEin weiterer begruendeter Satz.")
    if (keyboard) { await check(index).focus(); await check(index).press("Enter") }
    else await check(index).click()
    await page.waitForFunction(previous => window.__quizRegression.calls.length > previous, count, { timeout: 5000 })
    return count
  }
  const waitEnabled = async index => page.waitForFunction(i => !document.querySelectorAll(".lia-quiz__check")[i].disabled, index)
  const navigate = async (slide, count) => {
    await page.evaluate(value => { window.location.hash = String(value) }, slide)
    await page.waitForFunction(expected => [...document.querySelectorAll("lia-llm-textarea-host")].filter(host => !host.hidden && host.shadowRoot?.querySelector("textarea")).length === expected, count)
  }

  const area = page.locator("lia-llm-textarea-host textarea").first()
  assert.equal(await area.getAttribute("rows"), "5")
  assert.ok(await area.getAttribute("aria-label"))
  assert.equal(await input(0).getAttribute("aria-hidden"), "true")
  assert.equal(await area.evaluate(element => getComputedStyle(element).resize), "vertical")
  record("five-row resizable textarea with accessible label and hidden native single-line input")
  await page.evaluate(() => {
    const status = window.__quizRegression.status
    Object.assign(status, { phase: "loading", loadSource: "network" })
    window.dispatchEvent(new CustomEvent("lia-llm:status", { detail: status }))
  })
  const overlay = page.locator("#lia-llm-load-overlay")
  await overlay.waitFor({ state: "visible" })
  assert.equal(await overlay.getAttribute("role"), "status")
  assert.equal(await overlay.getAttribute("aria-live"), "polite")
  await page.evaluate(() => {
    const status = window.__quizRegression.status
    Object.assign(status, { phase: "ready", loadSource: "cache" })
    window.dispatchEvent(new CustomEvent("lia-llm:status", { detail: status }))
  })
  await overlay.waitFor({ state: "hidden" })
  record("model preload and accessible load-overlay status transitions")
  await start(0, "failed", true)
  await page.waitForFunction(() => document.querySelector(".lia-quiz__input").classList.contains("is-failure"))
  await waitEnabled(0)
  assert.match(await feedback(0).locator("[part=content]").innerText(), /noch nicht vollst|incomplete/u)
  const first = await page.evaluate(() => window.__quizRegression.calls[0])
  assert.equal(first.request.assessmentEngine, "compact")
  assert.equal(first.request.criteria.length, 6)
  assert.ok(first.request.criteria.every(criterion => criterion.required === false))
  assert.equal(first.request.passThreshold, 0.75)
  assert.equal(first.request.criterionThreshold, 0.55)
  assert.equal(first.request.referenceVariants.length, 0)
  assert.ok(first.request.reference.length > 400)
  assert.ok(first.request.answer.includes("\n"))
  assert.ok(first.hasSignal)
  record("failed, keyboard activation, multiline answer, compact, 6 atomic criteria, coverage")

  await start(1, "uncertain")
  await waitEnabled(1)
  assert.equal(await input(1).evaluate(element => element.closest(".lia-quiz").classList.contains("solved") || element.classList.contains("is-failure")), false)
  assert.equal(await page.evaluate(() => window.__quizRegression.calls.at(-1).request.assessmentEngine), "quality")
  await page.getByText("Die Antwort ist noch nicht eindeutig genug.", { exact: false }).first().waitFor()
  record("uncertain stays unassessed and quality reaches the evaluator")

  await start(2, "error")
  await waitEnabled(2)
  assert.equal(await input(2).evaluate(element => element.closest(".lia-quiz").classList.contains("solved") || element.classList.contains("is-failure")), false)
  await page.getByText("Regression: technischer Fehler", { exact: false }).first().waitFor()
  record("technical error releases the check button without an incorrect assessment")

  const cancelled = await start(3, "pending")
  assert.equal(await check(3).isDisabled(), true)
  assert.equal(await check(3).getAttribute("aria-busy"), "true")
  const status = activity(3).locator("[role=status]")
  assert.equal(await status.getAttribute("aria-live"), "polite")
  assert.match(await status.innerText(), /Regression: Inhalt/u)
  const cancel = activity(3).getByRole("button", { name: "Prüfung abbrechen" })
  await cancel.focus()
  await cancel.press("Enter")
  await waitEnabled(3)
  assert.equal(await check(3).getAttribute("aria-busy"), null)
  assert.equal(await page.evaluate(i => window.__quizRegression.calls[i].aborted, cancelled), true)
  await page.evaluate(() => window.__quizRegression.pending.shift()("passed"))
  await page.waitForTimeout(50)
  assert.equal(await input(3).evaluate(element => element.closest(".lia-quiz").classList.contains("solved")), false)
  await start(3, "failed")
  await waitEnabled(3)
  record("activity/progress ARIA, disabled check button, keyboard cancellation, AbortController, ignored stale completion and restart")

  await start(5, "passed")
  await page.waitForFunction(() => document.querySelectorAll(".lia-quiz")[5].classList.contains("solved"))
  await page.getByText("Musterloesung B fuer Aufgabe 6.", { exact: false }).waitFor()
  assert.equal(await page.getByText("Musterloesung A fuer Aufgabe 6.", { exact: false }).count(), 0)
  assert.equal(await input(5).isDisabled(), true)
  await feedback(5).getByRole("button", { name: "Sprache prüfen", exact: true }).click()
  await page.waitForFunction(() => window.__quizRegression.language.length === 1)
  const language = await page.evaluate(() => window.__quizRegression.language[0])
  assert.deepEqual(language.request.languageAnalysis, { spelling: true, syntax: true })
  assert.ok(language.hasSignal)
  await feedback(5).getByText("Rechtschreibfehler: 1", { exact: false }).waitFor()
  await feedback(5).getByText("Grammatik-/Satzbaufehler: 1", { exact: false }).waitFor()
  const correction = feedback(5).locator("[part=correction-toggle]")
  assert.equal(await correction.getAttribute("aria-expanded"), "true")
  await feedback(5).getByRole("region").getByText("Korrigierte Antwort.", { exact: true }).waitFor()
  await correction.press("Enter")
  assert.equal(await correction.getAttribute("aria-expanded"), "false")
  await correction.press("Enter")
  assert.equal(await correction.getAttribute("aria-expanded"), "true")
  record("passed, matching solution variant, solution=1, feedback=1, spelling/syntax and accessible correction panel")

  const abandoned = await start(4, "pending")
  await navigate(3, 1)
  assert.equal(await page.evaluate(i => window.__quizRegression.calls[i].aborted, abandoned), true)
  await page.evaluate(() => window.__quizRegression.pending.shift()("passed"))
  await start(0, "passed")
  await page.waitForFunction(() => document.querySelector(".lia-quiz").classList.contains("solved"))
  const short = await page.evaluate(() => window.__quizRegression.calls.at(-1))
  assert.equal(short.request.criteria.length, 1)
  await page.getByText("Ein Quadrat hat vier gleich lange Seiten", { exact: false }).waitFor()
  record("slide change aborts pending evaluation; a short atomic criteria block evaluates and renders its solution")

  await navigate(2, 6)
  await page.getByText("Musterloesung B fuer Aufgabe 6.", { exact: false }).waitFor()
  assert.equal(await page.getByText("Musterloesung A fuer Aufgabe 6.", { exact: false }).count(), 0)
  assert.equal(await input(4).evaluate(element => element.closest(".lia-quiz").classList.contains("solved")), false)
  record("returning to a slide preserves the selected solution and discards outdated results")
  result.evaluationCount = await page.evaluate(() => window.__quizRegression.calls.length)
}


async function runWeeklyInteractions(page, result) {
  result.interactions = []
  const check = index => page.locator(".lia-quiz__check").nth(index)
  const start = async (index, mode) => {
    const count = await page.evaluate(() => window.__quizRegression.calls.length)
    await page.evaluate(value => { window.__quizRegression.mode = value }, mode)
    await page.locator("lia-llm-textarea-host textarea").nth(index).fill("Eine begruendete Antwort mit allen erforderlichen Zusammenhaengen.")
    await check(index).click()
    await page.waitForFunction(previous => window.__quizRegression.calls.length > previous, count, { timeout: 5000 })
    return count
  }
  const quiz = page.locator(".lia-quiz").first()
  assert.equal(await quiz.getAttribute("data-solution-timer"), "300s")
  assert.equal(await check(0).getAttribute("data-__sol-timer-hooked"), "1")
  await start(0, "passed")
  await page.waitForFunction(() => document.querySelector(".lia-quiz").classList.contains("solved"))
  const solution = await quiz.locator(".lia-quiz__resolve").getAttribute("aria-hidden")
  assert.equal(solution, "true")
  const feedback = page.locator("lia-llm-feedback").first()
  await feedback.getByRole("button", { name: "Sprache prüfen", exact: true }).click()
  await page.waitForFunction(() => window.__quizRegression.language.length === 1)
  await feedback.getByText("Rechtschreibfehler: 1", { exact: false }).waitFor()
  await feedback.getByText("Grammatik-/Satzbaufehler: 1", { exact: false }).waitFor()
  result.interactions.push("successful real quiz with existing 300s data-solution-timer, feedback and optional spelling/syntax")

  const pending = await start(1, "pending")
  assert.equal(await check(1).isDisabled(), true)
  assert.equal(await check(1).getAttribute("aria-busy"), "true")
  const activity = page.locator("lia-llm-activity").nth(1)
  await activity.getByRole("button", { name: "Prüfung abbrechen" }).click()
  await page.waitForFunction(() => !document.querySelectorAll(".lia-quiz__check")[1].disabled)
  assert.equal(await page.evaluate(index => window.__quizRegression.calls[index].aborted, pending), true)
  await page.evaluate(() => window.__quizRegression.pending.shift()("passed"))
  await page.waitForTimeout(50)
  assert.equal(await page.locator(".lia-quiz").nth(1).evaluate(element => element.classList.contains("solved")), false)
  // lia-loot blocks duplicate checks until its 30-second pending timeout.
  // The isolated fixture above checks immediate retry without other templates.
  await page.waitForTimeout(30_500)
  await start(1, "failed")
  await page.waitForFunction(() => !document.querySelectorAll(".lia-quiz__check")[1].disabled)
  assert.match(await page.locator("lia-llm-feedback").nth(1).locator("[part=content]").innerText(), /noch nicht vollst/u)
  result.interactions.push("pending check disables button; cancel aborts and discards stale success; retry shows failed feedback while timer remains active")

  await start(2, "uncertain")
  await page.waitForFunction(() => !document.querySelectorAll(".lia-quiz__check")[2].disabled)
  await page.getByText("Die Antwort ist noch nicht eindeutig genug.", { exact: false }).first().waitFor()
  await start(3, "error")
  await page.waitForFunction(() => !document.querySelectorAll(".lia-quiz__check")[3].disabled)
  await page.getByText("Regression: technischer Fehler", { exact: false }).first().waitFor()
  result.interactions.push("uncertain and technical errors remain unassessed and permit retry")
}


async function main() {
  const readme = await readFile(path.join(root, "README.md"), "utf8")
  const bundle = await readFile(path.join(root, "dist/index.js"))
  const fixtureSource = await readFile(path.join(root, "test/fixtures/quiz-runtime" + (process.env.LIA_LLM_QUIZ_EXTREME === "1" ? "" : "-representative") + ".md"), "utf8")
  const adapter = readme.match(/(?:^|\n)@LLMQuiz_\r?\n([\s\S]*?)\r?\n@end/)[1]
  await mkdir(path.join(root, "test-results"), { recursive: true })
  report.adapterBytes = Buffer.byteLength(adapter)
  assert.ok(report.adapterBytes < 2_000, "Macro body exceeds 2,000 bytes; runtime logic must not be copied into each quiz")
  assert.ok(!/AbortController|\.evaluate\(|new Map\(|\.then\(/u.test(adapter), "Quiz macro contains evaluator control flow")
  assert.equal((fixtureSource.match(/\x60\x60\x60text @LLMQuiz\(/gu) || []).length, 7)
  report.fixtureBytes = Buffer.byteLength(fixtureSource)
  for (const id of selected) {
    const type = { chromium, firefox }[id.trim()]
    assert.ok(type, "Unknown browser " + id)
    const browserReport = { id, cases: [], errors: [] }
    report.browsers.push(browserReport)
    let browser
    try {
      browser = await type.launch({ headless: true })
      browserReport.version = browser.version()
      for (const scenario of [
        { name: "six-long-quizzes", url: fixture, slide: 2 },
        { name: "unchanged-weekly-course", url: course, slide: 3 },
      ].filter(scenario => !process.env.LIA_LLM_QUIZ_CASE || scenario.name === process.env.LIA_LLM_QUIZ_CASE)) {
        console.log("[" + id + "] " + scenario.name)
        const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" })
        const result = { name: scenario.name, pageErrors: [], requests: [], consoleErrors: [] }
        browserReport.cases.push(result)
        let page
        try {
          await context.addInitScript(installEvaluatorStub)
          await context.route("**/MINT-the-GAP/lia-llm/**", async route => {
            const url = new URL(route.request().url())
            let body, contentType
            if (url.pathname.endsWith("/README.md")) { body = readme; contentType = "text/plain; charset=utf-8" }
            else if (url.pathname.endsWith("/dist/index.js")) { body = bundle; contentType = "text/javascript; charset=utf-8" }
            else if (url.href === fixture) { body = fixtureSource; contentType = "text/plain; charset=utf-8" }
            else return route.continue()
            result.requests.push(url.href)
            await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "cache-control": "no-store", "content-type": contentType }, body })
          })
          page = await context.newPage()
          let abortParsing
          const parsingError = new Promise((_, reject) => { abortParsing = reject })
          parsingError.catch(() => {})
          page.on("pageerror", error => { result.pageErrors.push({ message: error.message, stack: error.stack }); abortParsing(error); console.error(error.message.length > 500 ? error.message.slice(0,100) + " ... " + error.message.slice(-100) : error.message) })
          page.on("console", message => { if (message.type() === "error") result.consoleErrors.push(message.text()) })
          page.on("response", async response => {
            if (response.url() === course && response.ok()) {
              try { result.courseSha256 = createHash("sha256").update(await response.body()).digest("hex") } catch {}
            }
          })
          await page.goto(viewer + "?" + scenario.url + "#" + scenario.slide, { waitUntil: "domcontentloaded", timeout })
          await Promise.race([parsingError, page.waitForFunction(() => document.querySelectorAll("lia-llm-textarea-host").length >= 6, null, { timeout })])
          await page.waitForFunction(() => [...document.querySelectorAll("lia-llm-textarea-host")].filter(host => !host.hidden && host.shadowRoot?.querySelector("textarea")).length >= 6, null, { timeout })
          result.textareas = await page.locator("lia-llm-textarea-host textarea:visible").count()
          result.quizzes = await page.locator(".lia-quiz__input").count()
          result.title = await page.title()
          result.viewerScripts = await page.locator("script[src]").evaluateAll(scripts => scripts.map(script => script.src).filter(src => src.startsWith("https://liascript.github.io/course/")))
          assert.equal(result.textareas, 6, "All six answer textareas must be visible")
          assert.ok(result.requests.some(url => url.endsWith("/README.md")), "Local template was not loaded")
          assert.ok(result.requests.some(url => url.endsWith("/dist/index.js")), "Local bundle was not loaded")
          await page.waitForTimeout(250)
          assert.deepEqual(result.pageErrors, [], "Uncaught browser error while parsing/rendering quizzes")
          result.preloadCalls = await page.evaluate(() => window.__quizRegression.preload)
          assert.ok(result.preloadCalls > 0, "Rendered quizzes must preload their model")
          if (scenario.url === fixture && process.env.LIA_LLM_QUIZ_EXTREME !== "1") await runInteractions(page, result)
          else if (scenario.url === course) await runWeeklyInteractions(page, result)
          assert.deepEqual(result.pageErrors, [], "Uncaught browser error during interaction")
          result.status = "passed"
        } catch (error) {
          if (page && !page.isClosed()) { result.body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "unavailable"); result.url = page.url() }
          if (page && !page.isClosed()) result.runtimeState = await page.evaluate(() => ({ calls: window.__quizRegression?.calls, runs: window.__quizRegression?.runs, quiz: [...document.querySelectorAll(".lia-quiz")].map(e=>e.outerHTML) })).catch(() => null)
          result.status = "failed"
          result.error = String(error.stack || error)
          console.error("[" + id + "/" + scenario.name + "] " + (result.error.length > 1500 ? result.error.slice(0,300) + " ... " + result.error.slice(-1100) : result.error))
        } finally { await context.close(); await writeFile(path.join(root, "test-results/browser-quiz-runtime.json"), JSON.stringify(report, null, 2) + "\n") }
      }
    } catch (error) { browserReport.errors.push(String(error.stack || error)) }
    finally { if (browser) await browser.close() }
  }
}

try { await main() }
catch (error) { report.error = String(error.stack || error) }
finally {
  await mkdir(path.join(root, "test-results"), { recursive: true })
  const target = path.join(root, "test-results/browser-quiz-runtime.json")
  await writeFile(target, JSON.stringify(report, null, 2) + "\n")
  console.log("Report: " + target)
}
if (report.error || report.browsers.some(browser => browser.errors.length || browser.cases.some(result => result.status !== "passed"))) {
  console.error(report.error || "Quiz runtime regression failed")
  process.exitCode = 1
}
