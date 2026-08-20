import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = resolve(root, "node_modules/@mlc-ai/web-llm/lib/index.js")
const target = resolve(root, "src/generated/webllm.js")
const generatedDirectory = resolve(root, "src/generated")

const originalSource = (await readFile(source, "utf8")).replace(
  /\n\/\/# sourceMappingURL=index\.js\.map\s*$/u,
  "\n",
)

const cacheAddCall = "yield this.cache.add(request);"
if (!originalSource.includes(cacheAddCall)) {
  throw new Error(
    "Die erwartete WebLLM-Cache-Implementierung wurde nicht gefunden.",
  )
}

// Cache.add() fetches internally and therefore cannot use our retrying,
// range-based downloader. Keep WebLLM's cache layout, but route the network
// request through the optional LiaLLM hook before Cache.put() consumes it.
let bundledSource = originalSource.replace(
  cacheAddCall,
  [
    "const artifactFetch = globalThis.__liaLlmArtifactFetch || fetch;",
    "const response = yield artifactFetch(request);",
    "if (!response.ok) {",
    "    throw new Error(`Unable to fetch ${url}, received status ${response.status}`);",
    "}",
    "yield this.cache.put(request, response);",
  ].join("\n                            "),
)

// WebLLM 0.2.84 leaves interruptSignal set after a non-streaming
// chat-completion is interrupted. The next request then exits before
// _generate() can reset the flag. Reset it when the request releases its
// model lock so a bounded Thinking attempt cannot poison later assessments.
const chatCompletionFinally = [
  "                return response;",
  "            }",
  "            finally {",
  "                yield lock.release();",
  "            }",
  "        });",
  "    }",
  "    completion(request) {",
].join("\n")
const chatCompletionFinallyMatches = bundledSource
  .split(chatCompletionFinally).length - 1
if (chatCompletionFinallyMatches !== 1) {
  throw new Error(
    "Der erwartete WebLLM-ChatCompletion-Cleanup wurde nicht eindeutig gefunden.",
  )
}
bundledSource = bundledSource.replace(
  chatCompletionFinally,
  chatCompletionFinally.replace(
    "            finally {\n                yield lock.release();",
    "            finally {\n                this.interruptSignal = false;\n                yield lock.release();",
  ),
)

await mkdir(generatedDirectory, { recursive: true })

let current = ""
try {
  current = await readFile(target, "utf8")
} catch {
  // The generated runtime does not exist on a fresh checkout yet.
}

if (current !== bundledSource) await writeFile(target, bundledSource, "utf8")
