import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { chromium, firefox, webkit } from "playwright-core"

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const fixturePath = "/test/browser-cache-hardening.html"
const fixtureQuery = process.env.LIA_LLM_HARDENING_QUERY || ""
const timeoutMs = Number(process.env.LIA_LLM_HARDENING_TIMEOUT_MS || 600_000)
const selectedIds = (
  process.env.LIA_LLM_HARDENING_BROWSERS ||
  "edge,chrome,chromium,firefox,webkit"
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
const keepProfiles = process.env.LIA_LLM_KEEP_PROFILES === "1"
const reportDirectory = path.join(projectRoot, "test-results")
const runtimeCachePrefix = "lia-llm-ort-runtime-"
const hardeningCsp = [
  "default-src 'self'",
  "connect-src 'self' https://liascript.github.io https://raw.githubusercontent.com https://storage.googleapis.com https://huggingface.co https://*.huggingface.co https://*.hf.co",
  "worker-src 'self' blob:",
  "script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
].join("; ")

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
])

function safeRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://local").pathname)
  const target = path.resolve(projectRoot, "." + pathname)
  const rootWithSeparator = projectRoot.endsWith(path.sep)
    ? projectRoot
    : projectRoot + path.sep
  if (target !== projectRoot && !target.startsWith(rootWithSeparator)) return null
  return target
}

function startServer() {
  const server = createServer((request, response) => {
    const target = safeRequestPath(request.url || "/")
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      response.end("Not found")
      return
    }
    const size = statSync(target).size
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": hardeningCsp,
      "Content-Length": String(size),
      "Content-Type":
        mimeTypes.get(path.extname(target).toLowerCase()) ||
        "application/octet-stream",
    })
    if (request.method === "HEAD") {
      response.end()
      return
    }
    createReadStream(target).pipe(response)
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Der lokale Testserver erhielt keinen TCP-Port."))
        return
      }
      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value)
    return url.origin + url.pathname
  } catch {
    return String(value)
  }
}

function summarizeNetwork(entries) {
  const hosts = {}
  for (const entry of entries) {
    const host = new URL(entry.url).host
    const item = (hosts[host] ||= {
      requests: 0,
      responses: 0,
      bytesDeclared: 0,
      statuses: {},
    })
    if (entry.kind === "request") item.requests += 1
    if (entry.kind === "response") {
      item.responses += 1
      item.statuses[entry.status] = (item.statuses[entry.status] || 0) + 1
      const length = Number(entry.contentLength)
      if (Number.isFinite(length) && length > 0) item.bytesDeclared += length
    }
  }
  return hosts
}

function candidateDefinitions() {
  return {
    edge: {
      id: "edge",
      label: "Microsoft Edge",
      type: chromium,
      launch: { channel: "msedge" },
      evidence: "real branded browser",
    },
    chrome: {
      id: "chrome",
      label: "Google Chrome",
      type: chromium,
      launch: { channel: "chrome" },
      evidence: "real branded browser",
    },
    chromium: {
      id: "chromium",
      label: "Playwright Chromium",
      type: chromium,
      launch: {},
      evidence: "real Chromium build",
    },
    firefox: {
      id: "firefox",
      label: "Playwright Firefox",
      type: firefox,
      launch: {},
      evidence: "Firefox engine build; not Android Firefox",
    },
    webkit: {
      id: "webkit",
      label: "Playwright WebKit",
      type: webkit,
      launch: {},
      evidence: "WebKit engine simulation; not Safari/iOS certification",
    },
  }
}

function externalTo(origin, value) {
  try {
    return new URL(value).origin !== origin
  } catch {
    return false
  }
}

async function withNodeTimeout(promise, limit, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} nach ${limit} ms abgebrochen.`)),
          limit,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    name: "Error",
    message: String(error),
  }
}

class PhaseExecutionError extends Error {
  constructor(phaseReport) {
    super(phaseReport.error.message)
    this.name = "PhaseExecutionError"
    this.phaseReport = phaseReport
  }
}

async function evaluateWithTimeout(page) {
  return withNodeTimeout(
    page.evaluate(() => window.runCacheHardening()),
    timeoutMs,
    "Browser-Härtetest",
  )
}

async function closeContext(context) {
  try {
    await withNodeTimeout(context.close(), 30_000, "Browser-Close")
  } catch {
    const browser = context.browser()
    if (browser) {
      await withNodeTimeout(browser.close(), 15_000, "Browser-Kill").catch(
        () => undefined,
      )
    }
  }
}

async function launchPhase(candidate, profile, origin, phase) {
  const startedAt = Date.now()
  const externalAttempts = []
  const networkEntries = []
  const pageErrors = []
  const progressLines = []
  let context = null
  let browserVersion = "unknown"

  const phaseReport = (result, error = null) => ({
    phase,
    browserVersion,
    durationMs: Date.now() - startedAt,
    result,
    externalAttempts: [...new Set(externalAttempts)],
    network: summarizeNetwork(networkEntries),
    pageErrors: [...pageErrors],
    progressLines: [...progressLines],
    lastProgress: progressLines.at(-1) || null,
    error,
  })

  try {
    context = await candidate.type.launchPersistentContext(profile, {
      ...candidate.launch,
      headless: true,
      viewport: { width: 1280, height: 900 },
    })
    browserVersion = context.browser()?.version() || "unknown"

    if (phase === "offline") {
      await context.route("**/*", async (route) => {
        const url = route.request().url()
        if (externalTo(origin, url)) {
          externalAttempts.push(sanitizeUrl(url))
          await route.abort("blockedbyclient")
          return
        }
        await route.continue()
      })
    }

    context.on("request", (request) => {
      const url = request.url()
      if (externalTo(origin, url)) {
        externalAttempts.push(sanitizeUrl(url))
      }
      if (
        externalTo(origin, url) ||
        new URLSearchParams(fixtureQuery).has("traceCache")
      ) {
        networkEntries.push({ kind: "request", url })
      }
    })
    context.on("response", (response) => {
      const url = response.url()
      if (
        externalTo(origin, url) ||
        new URLSearchParams(fixtureQuery).has("traceCache")
      ) {
        networkEntries.push({
          kind: "response",
          url,
          status: response.status(),
          contentLength: response.headers()["content-length"],
        })
      }
    })

    const page = context.pages()[0] || (await context.newPage())
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("console", (message) => {
      const text = message.text()
      if (text.startsWith("HARDENING_PROGRESS")) {
        progressLines.push(text)
        if (progressLines.length > 200) progressLines.shift()
        process.stdout.write(`[${candidate.id}/${phase}] ${text}\n`)
      }
    })

    await page.goto(origin + fixturePath + fixtureQuery, {
      waitUntil: "load",
      timeout: 120_000,
    })
    await page.waitForFunction(() => Boolean(window.LiaLLM), null, {
      timeout: 120_000,
    })
    const result = await evaluateWithTimeout(page)
    return phaseReport(result)
  } catch (error) {
    throw new PhaseExecutionError(phaseReport(null, serializeError(error)))
  } finally {
    if (context) await closeContext(context)
  }
}

function assertPhase(candidate, cold, warm) {
  const failures = []
  const runtimeCache = cold.result.manifest.find((entry) =>
    entry.name.startsWith(runtimeCachePrefix),
  )
  if (cold.result.before?.cached === true) {
    failures.push("Fresh-Profil war vor dem Cold-Run bereits gecacht.")
  }
  if (cold.result.after?.cached !== true) {
    failures.push("Kompaktmodell war nach dem Cold-Run nicht vollständig gecacht.")
  }
  if (!runtimeCache || runtimeCache.entries !== 2) {
    failures.push("Der versionierte ORT-Cache enthält nicht exakt MJS und WASM.")
  }
  if (cold.result.result?.passed !== true) {
    failures.push("Die echte Cold-Inferenz lieferte kein bestandenes Ergebnis.")
  }
  if (warm.result.before?.cached !== true) {
    failures.push("Der Cache wurde nach Browserneustart nicht vollständig erkannt.")
  }
  if (warm.result.preloadStatus?.loadSource !== "cache") {
    failures.push("Der Warmstart meldete nicht loadSource=cache.")
  }
  if (warm.result.result?.passed !== true) {
    failures.push("Die Offline-Inferenz nach Browserneustart schlug fehl.")
  }
  for (const [phaseName, phase] of [
    ["Cold-Run", cold],
    ["Warmstart", warm],
  ]) {
    for (const operation of ["preload", "evaluation"]) {
      const heartbeat = phase.result.uiResponsiveness?.[operation]
      if (heartbeat?.responsive !== true) {
        failures.push(
          `${phaseName}/${operation}: UI-Heartbeat überschritt ${heartbeat?.limitMs ?? "den Grenzwert"} ms (Maximum ${heartbeat?.maxGapMs ?? "nicht gemessen"} ms).`,
        )
      }
    }
  }
  if (warm.externalAttempts.length !== 0) {
    failures.push(
      `Der Warmstart versuchte ${warm.externalAttempts.length} externe Requests.`,
    )
  }
  if (cold.pageErrors.length || warm.pageErrors.length) {
    failures.push("Mindestens ein unbehandelter pageerror wurde beobachtet.")
  }
  return failures
}

async function clearAndInspect(candidate, profile, origin) {
  const context = await candidate.type.launchPersistentContext(profile, {
    ...candidate.launch,
    headless: true,
  })
  await context.route("**/*", async (route) => {
    if (externalTo(origin, route.request().url())) {
      await route.abort("blockedbyclient")
    } else {
      await route.continue()
    }
  })
  const page = context.pages()[0] || (await context.newPage())
  try {
    await page.goto(origin + fixturePath + fixtureQuery, {
      waitUntil: "load",
      timeout: 120_000,
    })
    await page.waitForFunction(() => Boolean(window.LiaLLM), null, {
      timeout: 120_000,
    })
    return await withNodeTimeout(
      page.evaluate(() => window.clearHardeningCache()),
      120_000,
      "Offline-clearCache",
    )
  } finally {
    await closeContext(context)
  }
}

function safelyRemoveProfileRoot(profileRoot) {
  const resolvedRoot = path.resolve(profileRoot)
  const allowedPrefix = path.resolve(tmpdir(), "lia-llm-browser-hardening-")
  if (!resolvedRoot.startsWith(allowedPrefix)) {
    throw new Error(`Unsicheres Profil-Löschziel abgelehnt: ${resolvedRoot}`)
  }
  rmSync(resolvedRoot, { force: true, recursive: true })
}

const definitions = candidateDefinitions()
const candidates = selectedIds.map((id) => {
  const candidate = definitions[id]
  if (!candidate) throw new Error(`Unbekannter Browser: ${id}`)
  return candidate
})

const { server, origin } = await startServer()
const profileRoot = mkdtempSync(
  path.join(tmpdir(), "lia-llm-browser-hardening-"),
)
const report = {
  generatedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  origin,
  fixtureQuery,
  timeoutMs,
  profilesKept: keepProfiles,
  browsers: [],
}
mkdirSync(reportDirectory, { recursive: true })
const reportName =
  "browser-hardening-" +
  new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-") +
  ".json"
const reportPath = path.join(reportDirectory, reportName)
const checkpointReport = () =>
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
checkpointReport()
process.stdout.write(`Zwischenreport: ${reportPath}\n`)

try {
  for (const candidate of candidates) {
    const profile = path.join(profileRoot, candidate.id)
    mkdirSync(profile, { recursive: true })
    process.stdout.write(`[${candidate.id}] Cold-Run startet.\n`)
    let cold = null
    let warm = null
    try {
      cold = await launchPhase(candidate, profile, origin, "cold")
      process.stdout.write(
        `[${candidate.id}] Browserneustart; externes Netz wird vollständig gesperrt.\n`,
      )
      warm = await launchPhase(candidate, profile, origin, "offline")
      const failures = assertPhase(candidate, cold, warm)
      let cleared = null
      let clearError = null
      try {
        cleared = await clearAndInspect(candidate, profile, origin)
        if (
          cleared.manifest.some((entry) =>
            entry.name.startsWith(runtimeCachePrefix),
          )
        ) {
          failures.push("Runtime-Cache blieb nach clearCache() erhalten.")
        }
      } catch (error) {
        clearError = error instanceof Error ? error.message : String(error)
        failures.push(`Offline-clearCache schlug fehl: ${clearError}`)
      }
      report.browsers.push({
        id: candidate.id,
        label: candidate.label,
        evidence: candidate.evidence,
        status: failures.length === 0 ? "passed" : "failed",
        failures,
        cold,
        warm,
        cleared,
        clearError,
      })
      process.stdout.write(
        `[${candidate.id}] ${failures.length === 0 ? "PASS" : "FAIL"}\n`,
      )
      checkpointReport()
    } catch (error) {
      const phaseError =
        error instanceof PhaseExecutionError
          ? error.phaseReport
          : {
              phase: "runner",
              browserVersion: "unknown",
              durationMs: 0,
              result: null,
              externalAttempts: [],
              network: {},
              pageErrors: [],
              progressLines: [],
              lastProgress: null,
              error: serializeError(error),
            }
      const message = phaseError.error.message
      const unavailable =
        /Executable doesn't exist|browserType\.launch|Failed to launch/iu.test(
          message,
        )
      report.browsers.push({
        id: candidate.id,
        label: candidate.label,
        evidence: candidate.evidence,
        status: unavailable ? "unavailable" : "failed",
        failures: [message],
        cold,
        warm,
        phaseError,
      })
      process.stdout.write(
        `[${candidate.id}] ${unavailable ? "UNAVAILABLE" : "FAIL"}: ${message}\n`,
      )
      checkpointReport()
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
  if (!keepProfiles) safelyRemoveProfileRoot(profileRoot)
}

checkpointReport()
process.stdout.write(`Report: ${reportPath}\n`)

if (report.browsers.some((entry) => entry.status === "failed")) {
  process.exitCode = 1
}
