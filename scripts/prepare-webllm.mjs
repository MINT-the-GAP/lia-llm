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
const bundledSource = originalSource.replace(
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

await mkdir(generatedDirectory, { recursive: true })

let current = ""
try {
  current = await readFile(target, "utf8")
} catch {
  // The generated runtime does not exist on a fresh checkout yet.
}

if (current !== bundledSource) await writeFile(target, bundledSource, "utf8")
