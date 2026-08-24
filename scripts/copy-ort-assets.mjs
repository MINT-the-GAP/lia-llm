import { copyFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export async function copyOrtAssets() {
  const targetDirectory = resolve(root, "dist")
  await mkdir(targetDirectory, { recursive: true })
  for (const asset of [
    "ort-wasm-simd-threaded.asyncify.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
  ]) {
    await copyFile(
      resolve(root, "node_modules/onnxruntime-web/dist", asset),
      resolve(targetDirectory, asset),
    )
  }
  await copyFile(
    resolve(
      root,
      "node_modules/@cspell/dict-de-de/German_de_DE.trie.gz",
    ),
    resolve(targetDirectory, "German_de_DE.d94b8665.trie.gz"),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copyOrtAssets()
}
