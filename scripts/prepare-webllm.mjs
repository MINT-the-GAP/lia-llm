import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = resolve(root, "node_modules/@mlc-ai/web-llm/lib/index.js")
const target = resolve(root, "src/generated/webllm.js")

const bundledSource = (await readFile(source, "utf8")).replace(
  /\n\/\/# sourceMappingURL=index\.js\.map\s*$/u,
  "\n",
)

await mkdir(dirname(target), { recursive: true })

let current = ""
try {
  current = await readFile(target, "utf8")
} catch {
  // The generated runtime does not exist on a fresh checkout yet.
}

if (current !== bundledSource) await writeFile(target, bundledSource, "utf8")
