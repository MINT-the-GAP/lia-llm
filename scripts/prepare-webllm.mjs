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

function replaceExactlyOnce(sourceText, expected, replacement, label) {
  const occurrences = sourceText.split(expected).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `Die erwartete WebLLM-Stelle für ${label} wurde nicht eindeutig gefunden (${occurrences}).`,
    )
  }
  return sourceText.replace(expected, replacement)
}

const cacheAddCall = "yield this.cache.add(request);"

// Cache.add() fetches internally and therefore cannot use our retrying,
// range-based downloader. Keep WebLLM's cache layout, but route the network
// request through the optional LiaLLM hook before Cache.put() consumes it.
let bundledSource = replaceExactlyOnce(
  originalSource,
  cacheAddCall,
  [
    "const artifactFetch = globalThis.__liaLlmArtifactFetch || fetch;",
    "const response = yield artifactFetch(request);",
    "if (!response.ok) {",
    "    throw new Error(`Unable to fetch ${url}, received status ${response.status}`);",
    "}",
    "yield this.cache.put(request, response);",
  ].join("\n                            "),
  "den Artefakt-Download",
)

// WebLLM 0.2.84 evicts and disposes ShapeTuples although makeShapeTuple()
// returns the cached object itself. Longer prompts can still use such a tuple
// after the 256-entry LRU limit and then lose the WebGPU device. ShapeTuples
// are immutable for the TVM lifetime, so retain them until CacheState.dispose().
bundledSource = replaceExactlyOnce(
  bundledSource,
  "this.shapeCache = new LRUCache(shapeCacheSize, (_key, value) => value.dispose());",
  "this.shapeCache = new LRUCache(Number.POSITIVE_INFINITY);",
  "den ShapeTuple-Cache",
)

// Keep a pending GPU-to-CPU mapAsync promise alive even when later queue work
// is submitted. The 0.2.84 fast path otherwise drops that promise and sync()
// may return before getMappedRange()/unmap() has completed.
const webGpuMemberIndent = "\t\t        "
const webGpuBodyIndent = "\t\t            "
const webGpuNestedIndent = "\t\t                "
const webGpuDeepIndent = "\t\t                    "

bundledSource = replaceExactlyOnce(
  bundledSource,
  [
    "this.pendingGPUToCPUCopy = null;",
    "// Batched command encoding: accumulate compute passes in a single encoder,",
  ].join("\n" + webGpuBodyIndent),
  [
    "this.pendingGPUToCPUCopy = null;",
    "this.pendingGPUToCPUCopyIsQueueTail = false;",
    "// Batched command encoding: accumulate compute passes in a single encoder,",
  ].join("\n" + webGpuBodyIndent),
  "den GPU-Readback-Zustand",
)

bundledSource = replaceExactlyOnce(
  bundledSource,
  [
    "// the heavier onSubmittedWorkDone). Reset to null after any non-copy",
    "// queue submission so we fall back to onSubmittedWorkDone.",
  ].join("\n" + webGpuBodyIndent),
  [
    "// the heavier onSubmittedWorkDone). Keep the promise until sync();",
    "// the queue-tail flag records whether later work must also be awaited.",
  ].join("\n" + webGpuBodyIndent),
  "den Kommentar zum GPU-Readback-Zustand",
)

bundledSource = replaceExactlyOnce(
  bundledSource,
  [
    "// A compute submission is now the last queue operation, so the",
    "// GPU→CPU copy fast path in sync() is no longer valid.",
    "this.pendingGPUToCPUCopy = null;",
  ].join("\n" + webGpuNestedIndent),
  [
    "// A compute submission is now the last queue operation, so the",
    "// GPU→CPU copy fast path in sync() must also await the queue.",
    "this.pendingGPUToCPUCopyIsQueueTail = false;",
  ].join("\n" + webGpuNestedIndent),
  "das Beibehalten ausstehender GPU-Readbacks",
)

const oldSync = [
  "if (this.pendingGPUToCPUCopy) {",
  webGpuDeepIndent + "const p = this.pendingGPUToCPUCopy;",
  webGpuDeepIndent + "this.pendingGPUToCPUCopy = null;",
  webGpuDeepIndent + "yield p;",
  webGpuNestedIndent + "}",
  webGpuNestedIndent + "else {",
  webGpuDeepIndent + "yield this.device.queue.onSubmittedWorkDone();",
  webGpuNestedIndent + "}",
].join("\n")
const synchronizedReadback = [
  "const pendingRead = this.pendingGPUToCPUCopy;",
  webGpuNestedIndent + "const pendingReadIsQueueTail = this.pendingGPUToCPUCopyIsQueueTail;",
  webGpuNestedIndent + "this.pendingGPUToCPUCopy = null;",
  webGpuNestedIndent + "this.pendingGPUToCPUCopyIsQueueTail = false;",
  webGpuNestedIndent + "if (!pendingRead) {",
  webGpuDeepIndent + "yield this.device.queue.onSubmittedWorkDone();",
  webGpuNestedIndent + "}",
  webGpuNestedIndent + "else if (pendingReadIsQueueTail) {",
  webGpuDeepIndent + "yield pendingRead;",
  webGpuNestedIndent + "}",
  webGpuNestedIndent + "else {",
  webGpuDeepIndent + "const queueDone = this.device.queue.onSubmittedWorkDone();",
  webGpuDeepIndent + "yield Promise.all([pendingRead, queueDone]);",
  webGpuNestedIndent + "}",
].join("\n")
bundledSource = replaceExactlyOnce(
  bundledSource,
  oldSync,
  synchronizedReadback,
  "die GPU-Readback-Synchronisation",
)

const queueTailUpdates = [
  [
    "this.canvasRenderManager.draw(this.gpuBufferFromPtr(ptr), height, width);",
    [
      "this.flushCommands();",
      "this.canvasRenderManager.draw(this.gpuBufferFromPtr(ptr), height, width);",
      "this.pendingGPUToCPUCopyIsQueueTail = false;",
    ].join("\n" + webGpuBodyIndent),
    "das Canvas-Zeichnen",
  ],
  [
    "this.device.queue.writeBuffer(this.gpuBufferFromPtr(toPtr), toOffset, rawBytes, 0, nbytes);",
    [
      "this.device.queue.writeBuffer(this.gpuBufferFromPtr(toPtr), toOffset, rawBytes, 0, nbytes);",
      "this.pendingGPUToCPUCopyIsQueueTail = false;",
    ].join("\n" + webGpuBodyIndent),
    "den direkten GPU-Write",
  ],
  [
    "(_a = this.canvasRenderManager) === null || _a === void 0 ? void 0 : _a.clear();",
    [
      "(_a = this.canvasRenderManager) === null || _a === void 0 ? void 0 : _a.clear();",
      "this.pendingGPUToCPUCopyIsQueueTail = false;",
    ].join("\n" + webGpuBodyIndent),
    "das Canvas-Leeren",
  ],
  [
    "this.device.queue.writeBuffer(podArgBuffer, 0, i32View.buffer);",
    [
      "this.device.queue.writeBuffer(podArgBuffer, 0, i32View.buffer);",
      "this.pendingGPUToCPUCopyIsQueueTail = false;",
    ].join("\n" + webGpuDeepIndent),
    "den Uniform-Buffer-Write",
  ],
  [
    "this.device.queue.writeBuffer(this.gpuBufferFromPtr(to), toOffset, rawBytes, 0, nbytes);",
    [
      "this.device.queue.writeBuffer(this.gpuBufferFromPtr(to), toOffset, rawBytes, 0, nbytes);",
      "this.pendingGPUToCPUCopyIsQueueTail = false;",
    ].join("\n" + webGpuBodyIndent),
    "den CPU-zu-GPU-Write",
  ],
  [
    [
      "this.pendingGPUToCPUCopy = this.pendingGPUToCPUCopy",
      "    ? this.pendingGPUToCPUCopy.then(() => readPromise)",
      "    : readPromise;",
    ].join("\n" + webGpuBodyIndent),
    [
      "this.pendingGPUToCPUCopy = this.pendingGPUToCPUCopy",
      "    ? this.pendingGPUToCPUCopy.then(() => readPromise)",
      "    : readPromise;",
      "this.pendingGPUToCPUCopyIsQueueTail = true;",
    ].join("\n" + webGpuBodyIndent),
    "das Markieren des GPU-Readbacks",
  ],
  [
    [
      "const copyCommands = copyEncoder.finish();",
      webGpuBodyIndent + "this.device.queue.submit([copyCommands]);",
      webGpuMemberIndent + "}",
      webGpuMemberIndent + "gpuBufferFromPtr(ptr) {",
    ].join("\n"),
    [
      "const copyCommands = copyEncoder.finish();",
      webGpuBodyIndent + "this.device.queue.submit([copyCommands]);",
      webGpuBodyIndent + "this.pendingGPUToCPUCopyIsQueueTail = false;",
      webGpuMemberIndent + "}",
      webGpuMemberIndent + "gpuBufferFromPtr(ptr) {",
    ].join("\n"),
    "den GPU-internen Copy",
  ],
]
for (const [expected, replacement, label] of queueTailUpdates) {
  bundledSource = replaceExactlyOnce(
    bundledSource,
    expected,
    replacement,
    label,
  )
}

// Batched command encoding in WebLLM 0.2.83+ can turn a long prefill into one
// command buffer that trips Windows' GPU watchdog. Bound each buffer to 32
// compute passes: this preserves most batching while restoring regular submit
// boundaries. Queue ordering preserves uniform-buffer writes without CPU waits.
bundledSource = replaceExactlyOnce(
  bundledSource,
  [
    "compute.end();",
    "// In debug mode, flush immediately so we can observe each submission.",
  ].join("\n" + webGpuDeepIndent),
  [
    "compute.end();",
    "if (this.pendingDispatchCount >= 32) {",
    "    this.flushCommands();",
    "}",
    "// In debug mode, flush remaining work and observe its completion.",
  ].join("\n" + webGpuDeepIndent),
  "das Begrenzen der WebGPU-Command-Buffer",
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
bundledSource = replaceExactlyOnce(
  bundledSource,
  chatCompletionFinally,
  chatCompletionFinally.replace(
    "            finally {\n                yield lock.release();",
    "            finally {\n                this.interruptSignal = false;\n                yield lock.release();",
  ),
  "den ChatCompletion-Cleanup",
)

await mkdir(generatedDirectory, { recursive: true })

let current = ""
try {
  current = await readFile(target, "utf8")
} catch {
  // The generated runtime does not exist on a fresh checkout yet.
}

if (current !== bundledSource) await writeFile(target, bundledSource, "utf8")
