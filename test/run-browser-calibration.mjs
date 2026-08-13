import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { access, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const calibrationPage =
  process.argv[2] ??
  process.env.LIA_LLM_CALIBRATION_PAGE ??
  "test/browser-holistic-calibration.html"
const executionMode = process.argv[3]
const useWebGpu =
  executionMode === "cpu"
    ? false
    : executionMode === "webgpu"
      ? true
      : process.env.LIA_LLM_WEBGPU !== "0"

function browserMetadata(browserPath) {
  const executable = basename(browserPath).toLowerCase()
  if (executable.includes("msedge") || executable.includes("edge")) {
    return { label: "Microsoft Edge", profileKey: "edge" }
  }
  if (executable.includes("chrome")) {
    return { label: "Google Chrome", profileKey: "chrome" }
  }
  if (executable.includes("chromium")) {
    return { label: "Chromium", profileKey: "chromium" }
  }
  return { label: "Browser", profileKey: "custom" }
}

const configuredBrowserPath = process.env.LIA_LLM_BROWSER_PATH?.trim()
const browserCandidates =
  process.platform === "win32"
    ? [
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]
      : [
          "/usr/bin/microsoft-edge",
          "/usr/bin/microsoft-edge-stable",
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ]

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

if (configuredBrowserPath && !(await pathExists(configuredBrowserPath))) {
  throw new Error(
    `Configured browser executable does not exist: ${configuredBrowserPath} (LIA_LLM_BROWSER_PATH)`,
  )
}

let browserPath = configuredBrowserPath
for (const candidate of browserCandidates) {
  if (!browserPath && (await pathExists(candidate))) browserPath = candidate
}
if (!browserPath) {
  throw new Error(
    "Could not find a supported browser executable. Set LIA_LLM_BROWSER_PATH explicitly.",
  )
}

const { label: browserLabel, profileKey } = browserMetadata(browserPath)
const configuredProfilePath = process.env.LIA_LLM_BROWSER_PROFILE?.trim()
const profilePath =
  configuredProfilePath ||
  join(
    tmpdir(),
    `lia-llm-${profileKey}-${useWebGpu ? "webgpu-profile-20260721-v1" : "browser-profile-20260720-v3"}`,
  )
let pageUrl = ""

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", pageUrl).pathname)
    const localPath = normalize(join(root, pathname.replace(/^\/+/, "")))
    if (!localPath.startsWith(root)) throw new Error("path outside root")
    const info = await stat(localPath)
    if (!info.isFile()) throw new Error("not a file")
    response.writeHead(200, {
      "content-type": contentTypes[extname(localPath)] ?? "application/octet-stream",
      "content-length": String(info.size),
    })
    createReadStream(localPath).pipe(response)
  } catch {
    response.writeHead(404)
    response.end("not found")
  }
})

await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})
const serverAddress = server.address()
if (!serverAddress || typeof serverAddress === "string") {
  throw new Error("Could not determine the calibration server port")
}
pageUrl = `http://127.0.0.1:${serverAddress.port}/${calibrationPage.replace(/^\/+/, "")}`

const debuggingProbe = createServer()
await new Promise((resolve, reject) => {
  debuggingProbe.once("error", reject)
  debuggingProbe.listen(0, "127.0.0.1", resolve)
})
const debuggingAddress = debuggingProbe.address()
if (!debuggingAddress || typeof debuggingAddress === "string") {
  throw new Error("Could not determine a browser debugging port")
}
const debuggingPort = debuggingAddress.port
await new Promise((resolve) => debuggingProbe.close(resolve))

const browserArguments = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  `--user-data-dir=${profilePath}`,
  `--remote-debugging-port=${debuggingPort}`,
  pageUrl,
]
if (useWebGpu) {
  browserArguments.unshift("--enable-unsafe-webgpu", "--enable-features=Vulkan")
} else {
  browserArguments.unshift("--disable-gpu")
}

const browser = spawn(
  browserPath,
  browserArguments,
  { stdio: ["ignore", "ignore", "pipe"] },
)

let stderr = ""
let browserExit = null
let browserSpawnError = null
browser.stderr.setEncoding("utf8")
browser.stderr.on("data", (chunk) => {
  stderr += chunk
})
browser.once("error", (error) => {
  browserSpawnError = error
})
browser.once("exit", (code, signal) => {
  browserExit = { code, signal }
})

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const waitForBrowserExit = (milliseconds) =>
  browserExit !== null
    ? Promise.resolve()
    : Promise.race([
        new Promise((resolve) => browser.once("exit", resolve)),
        delay(milliseconds),
      ])

async function findPage() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (browserSpawnError) {
      throw new Error(`${browserLabel} failed to start: ${browserSpawnError.message}`)
    }
    if (browserExit) {
      throw new Error(
        `${browserLabel} exited before exposing the calibration page (exit: ${JSON.stringify(browserExit)})`,
      )
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json`, {
        signal: AbortSignal.timeout(1_000),
      })
      const pages = await response.json()
      const page = pages.find((entry) => entry.type === "page" && entry.url === pageUrl)
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // The browser is still starting.
    }
    await delay(250)
  }
  throw new Error(
    `${browserLabel} debugging endpoint did not expose the calibration page (exit: ${JSON.stringify(browserExit)})`,
  )
}

let socket
try {
  const page = await findPage()
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })

  let messageId = 0
  const pending = new Map()
  const rejectPending = (reason) => {
    for (const { reject } of pending.values()) reject(reason)
    pending.clear()
  }
  socket.addEventListener("error", () => {
    rejectPending(new Error(`${browserLabel} DevTools connection failed.\n${stderr}`))
  })
  socket.addEventListener("close", () => {
    rejectPending(
      new Error(
        `${browserLabel} DevTools connection closed (exit: ${JSON.stringify(browserExit)}).\n${stderr}`,
      ),
    )
  })
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  })

  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++messageId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })

  await command("Runtime.enable")
  const deadline = Date.now() + (useWebGpu ? 30 : 15) * 60_000
  let lastCount = -1
  while (Date.now() < deadline) {
    const result = await command("Runtime.evaluate", {
      expression:
        "JSON.stringify({done:Boolean(window.__liaCalibrationDone),results:window.__liaCalibration||[],total:window.__liaCalibrationExpected||0,error:window.__liaCalibrationError||null})",
      returnByValue: true,
    })
    const state = JSON.parse(result.result.value)
    if (state.results.length !== lastCount) {
      lastCount = state.results.length
      process.stdout.write(`completed ${lastCount}/${state.total || "?"}\n`)
    }
    if (state.done) {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
      if (
        state.error ||
        state.total < 1 ||
        state.results.length !== state.total ||
        state.results.some(
          (result) => result.matches !== true || result.compactFeedbackHasCriteria,
        )
      ) {
        process.exitCode = 1
      }
      break
    }
    await delay(2_000)
  }
  if (Date.now() >= deadline) throw new Error("Calibration timed out")
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${stderr}`)
  process.exitCode = 1
} finally {
  if (socket?.readyState === 1 && browserExit === null) {
    try {
      socket.send(
        JSON.stringify({
          id: Number.MAX_SAFE_INTEGER,
          method: "Browser.close",
        }),
      )
      await waitForBrowserExit(2_000)
    } catch {
      // The browser may already be shutting down.
    }
  }
  socket?.close()
  if (browserExit === null && !browserSpawnError) {
    browser.kill()
    await waitForBrowserExit(2_000)
  }
  server.closeIdleConnections()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
