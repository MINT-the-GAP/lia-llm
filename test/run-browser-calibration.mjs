import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe"
const profilePath = "C:/tmp/lia-llm-browser-profile-20260720-v3"
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
pageUrl = `http://127.0.0.1:${serverAddress.port}/test/browser-holistic-calibration.html`

const debuggingProbe = createServer()
await new Promise((resolve, reject) => {
  debuggingProbe.once("error", reject)
  debuggingProbe.listen(0, "127.0.0.1", resolve)
})
const debuggingAddress = debuggingProbe.address()
if (!debuggingAddress || typeof debuggingAddress === "string") {
  throw new Error("Could not determine a Chrome debugging port")
}
const debuggingPort = debuggingAddress.port
await new Promise((resolve) => debuggingProbe.close(resolve))

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${debuggingPort}`,
    pageUrl,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
)

let stderr = ""
let chromeExit = null
chrome.stderr.setEncoding("utf8")
chrome.stderr.on("data", (chunk) => {
  stderr += chunk
})
chrome.once("exit", (code, signal) => {
  chromeExit = { code, signal }
})

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const waitForChromeExit = (milliseconds) =>
  chromeExit !== null
    ? Promise.resolve()
    : Promise.race([
        new Promise((resolve) => chrome.once("exit", resolve)),
        delay(milliseconds),
      ])

async function findPage() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json`, {
        signal: AbortSignal.timeout(1_000),
      })
      const pages = await response.json()
      const page = pages.find((entry) => entry.type === "page" && entry.url === pageUrl)
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // Chrome is still starting.
    }
    await delay(250)
  }
  throw new Error(
    `Chrome debugging endpoint did not expose the calibration page (exit: ${JSON.stringify(chromeExit)})`,
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
    rejectPending(new Error(`Chrome DevTools connection failed.\n${stderr}`))
  })
  socket.addEventListener("close", () => {
    rejectPending(
      new Error(
        `Chrome DevTools connection closed (exit: ${JSON.stringify(chromeExit)}).\n${stderr}`,
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
  const deadline = Date.now() + 15 * 60_000
  let lastCount = -1
  while (Date.now() < deadline) {
    const result = await command("Runtime.evaluate", {
      expression:
        "JSON.stringify({done:Boolean(window.__liaCalibrationDone),results:window.__liaCalibration||[],error:window.__liaCalibrationError||null})",
      returnByValue: true,
    })
    const state = JSON.parse(result.result.value)
    if (state.results.length !== lastCount) {
      lastCount = state.results.length
      process.stdout.write(`completed ${lastCount}/8\n`)
    }
    if (state.done) {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
      if (
        state.error ||
        state.results.length !== 8 ||
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
  if (socket?.readyState === 1 && chromeExit === null) {
    try {
      socket.send(
        JSON.stringify({
          id: Number.MAX_SAFE_INTEGER,
          method: "Browser.close",
        }),
      )
      await waitForChromeExit(2_000)
    } catch {
      // The browser may already be shutting down.
    }
  }
  socket?.close()
  if (chromeExit === null) {
    chrome.kill()
    await waitForChromeExit(2_000)
  }
  server.closeIdleConnections()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
