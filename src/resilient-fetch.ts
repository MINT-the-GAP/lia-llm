const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024
const DEFAULT_STALL_TIMEOUT_MS = 45_000
const DEFAULT_RETRY_DELAYS_MS = [0, 750, 2_000, 5_000] as const

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface DownloadActivity {
  url: string
  loaded: number
  total?: number
}

export interface DownloadRetry {
  url: string
  attempt: number
  error: unknown
}

export interface ResilientFetchOptions {
  chunkSizeBytes?: number
  stallTimeoutMs?: number
  retryDelaysMs?: readonly number[]
  shouldChunk?(request: Request): boolean
  onActivity?(activity: DownloadActivity): void
  onRetry?(retry: DownloadRetry): void
}

interface RangeResponse {
  response: Response
  bytes: Uint8Array
  start: number
  end: number
  total: number
}

interface FullObjectResponse {
  kind: "full-object"
  response: Response
  total: number
}

function isFullObjectResponse(
  response: RangeResponse | FullObjectResponse,
): response is FullObjectResponse {
  return "kind" in response && response.kind === "full-object"
}

const DIRECT_FALLBACK = Symbol("direct-fallback")

class DownloadStalledError extends Error {
  constructor() {
    super("Der Download hat zu lange keine Daten mehr geliefert.")
    this.name = "TimeoutError"
  }
}

class NonRetryableDownloadError extends Error {}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error(
    typeof reason === "string" && reason.trim()
      ? reason
      : "Der Download wurde beendet.",
  )
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal.reason)
}

function combinedSignal(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const active = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]

  const abortSignal = AbortSignal as typeof AbortSignal & {
    any?(signals: AbortSignal[]): AbortSignal
  }
  if (typeof abortSignal.any === "function") return abortSignal.any(active)

  const controller = new AbortController()
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    signal.addEventListener("abort", () => abort(signal), { once: true })
  }
  return controller.signal
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function nonNegativeInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function expectedResponseBytes(response: Response): number | undefined {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase()
  if (encoding && encoding !== "identity") return undefined
  return nonNegativeInteger(response.headers.get("content-length"))
}

function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u)
  if (!match) return null
  const start = Number.parseInt(match[1]!, 10)
  const end = Number.parseInt(match[2]!, 10)
  const total = Number.parseInt(match[3]!, 10)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null
  }
  return { start, end, total }
}

function copyResponse(
  response: Response,
  body: BodyInit | null,
  headers = response.headers,
): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function replayBody(
  chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++]!)
      if (index >= chunks.length) controller.close()
    },
  })
}

function responseMayHaveBody(request: Request, response: Response): boolean {
  return (
    request.method !== "HEAD" &&
    response.status !== 204 &&
    response.status !== 205 &&
    response.status !== 304
  )
}

function waitFor<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
): Promise<T> {
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = (): void =>
      finish(() => reject(abortError(signal?.reason)))
    const timer = setTimeout(() => {
      finish(() => {
        onTimeout()
        reject(new DownloadStalledError())
      })
    }, timeoutMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

function waitDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal?.reason))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function shouldChunkModelRequest(request: Request): boolean {
  if (request.method !== "GET" || request.headers.has("range")) return false
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return false
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    /\.(?:bin|onnx|wasm)$/iu.test(url.pathname)
  )
}

export class ResilientFetchSession {
  private readonly controller = new AbortController()
  private readonly baseFetch: FetchLike
  private readonly chunkSizeBytes: number
  private readonly stallTimeoutMs: number
  private readonly retryDelaysMs: readonly number[]
  private readonly shouldChunk: (request: Request) => boolean
  private readonly onActivity?: (activity: DownloadActivity) => void
  private readonly onRetry?: (retry: DownloadRetry) => void

  constructor(baseFetch: FetchLike, options: ResilientFetchOptions = {}) {
    this.baseFetch = baseFetch
    this.chunkSizeBytes = Math.max(
      1,
      Math.floor(options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES),
    )
    this.stallTimeoutMs = Math.max(
      1,
      Math.floor(options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS),
    )
    this.retryDelaysMs =
      options.retryDelaysMs && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
        : DEFAULT_RETRY_DELAYS_MS
    this.shouldChunk = options.shouldChunk ?? shouldChunkModelRequest
    this.onActivity = options.onActivity
    this.onRetry = options.onRetry
  }

  readonly fetch: FetchLike = async (input, init) => {
    return this.fetchRequest(input, init)
  }

  async fetchExact(
    input: RequestInfo | URL,
    expectedByteLength: number,
    init?: RequestInit,
  ): Promise<Response> {
    if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
      throw new RangeError("Die erwartete Downloadgröße ist ungültig.")
    }
    return this.fetchRequest(input, init, expectedByteLength)
  }

  private async fetchRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
    expectedByteLength?: number,
  ): Promise<Response> {
    const original = new Request(input, init)
    const signal = combinedSignal([original.signal, this.controller.signal])
    const request = new Request(original, { signal })
    throwIfAborted(signal)
    return this.shouldChunk(request)
      ? this.fetchChunked(request, expectedByteLength)
      : this.fetchDirect(request, expectedByteLength)
  }

  abort(reason = "Der Modell-Download wurde beendet."): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  private retryDelay(attempt: number): number {
    return this.retryDelaysMs[
      Math.min(attempt, this.retryDelaysMs.length - 1)
    ] ?? 0
  }

  private reportRetry(request: Request, attempt: number, error: unknown): void {
    try {
      this.onRetry?.({ url: request.url, attempt: attempt + 1, error })
    } catch {
      // Progress observers must never affect the download.
    }
  }

  private reportActivity(activity: DownloadActivity): void {
    try {
      this.onActivity?.(activity)
    } catch {
      // Progress observers must never affect the download.
    }
  }

  private async withRetries<T>(
    request: Request,
    operation: (
      attemptController: AbortController,
      signal: AbortSignal,
      finalAttempt: boolean,
    ) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
      const attemptController = new AbortController()
      const signal = combinedSignal([
        request.signal,
        attemptController.signal,
      ])!
      try {
        return await operation(
          attemptController,
          signal,
          attempt + 1 >= this.retryDelaysMs.length,
        )
      } catch (error) {
        if (!attemptController.signal.aborted) attemptController.abort(error)
        if (request.signal.aborted) throw abortError(request.signal.reason)
        if (error instanceof NonRetryableDownloadError) throw error
        lastError = error
        if (attempt + 1 >= this.retryDelaysMs.length) throw error
        this.reportRetry(request, attempt + 1, error)
        await waitDelay(this.retryDelay(attempt + 1), request.signal)
      }
    }
    throw lastError
  }

  private fetchAttempt(
    request: Request,
    signal: AbortSignal,
    attemptController: AbortController,
  ): Promise<Response> {
    return waitFor(
      this.baseFetch(request),
      this.stallTimeoutMs,
      signal,
      () => attemptController.abort(),
    )
  }

  private async bufferResponse(
    response: Response,
    request: Request,
    signal: AbortSignal,
    attemptController: AbortController,
    expectedByteLength?: number,
  ): Promise<Response> {
    const expected = expectedByteLength ?? expectedResponseBytes(response)
    if (!response.body) {
      if (
        expected !== undefined &&
        expected !== 0 &&
        responseMayHaveBody(request, response)
      ) {
        throw new Error(
          `Unvollst\u00e4ndiger Download: 0 von ${expected} Bytes empfangen.`,
        )
      }
      return response
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    try {
      while (true) {
        const item = await waitFor(
          reader.read(),
          this.stallTimeoutMs,
          signal,
          () => attemptController.abort(),
        )
        if (item.done) break
        chunks.push(item.value)
        loaded += item.value.byteLength
        if (expected !== undefined && loaded > expected) {
          throw new Error(
            `Zu viele Download-Daten: ${loaded} statt ${expected} Bytes empfangen.`,
          )
        }
        this.reportActivity({ url: request.url, loaded, total: expected })
      }
      if (expected !== undefined && loaded !== expected) {
        throw new Error(
          `Unvollst\u00e4ndiger Download: ${loaded} von ${expected} Bytes empfangen.`,
        )
      }
    } catch (error) {
      if (!attemptController.signal.aborted) attemptController.abort(error)
      void reader.cancel(error).catch(() => undefined)
      throw error
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // A timed-out read may still own the lock until abort propagation ends.
      }
    }

    // Fetch exposes an already decoded body. A cross-origin proxy may still
    // expose the compressed Content-Length while hiding Content-Encoding.
    // The replayed response therefore describes the verified logical bytes.
    const headers = new Headers(response.headers)
    headers.delete("content-encoding")
    headers.set("content-length", String(loaded))
    return copyResponse(response, replayBody(chunks), headers)
  }

  private async fetchDirect(
    request: Request,
    expectedByteLength?: number,
  ): Promise<Response> {
    return this.withRetries(
      request,
      async (attemptController, signal, finalAttempt) => {
        const attemptRequest = new Request(request, { signal })
        const response = await this.fetchAttempt(
          attemptRequest,
          signal,
          attemptController,
        )
        if (retryableStatus(response.status) && !finalAttempt) {
          void response.body?.cancel().catch(() => undefined)
          throw new Error(`HTTP ${response.status} f\u00fcr ${request.url}`)
        }
        return this.bufferResponse(
          response,
          attemptRequest,
          signal,
          attemptController,
          response.ok ? expectedByteLength : undefined,
        )
      },
    )
  }

  private async readRange(
    response: Response,
    request: Request,
    range: { start: number; end: number; total: number },
    attemptController: AbortController,
  ): Promise<Uint8Array> {
    if (!response.body) throw new Error(`Leere Download-Antwort f\u00fcr ${request.url}`)
    const reader = response.body.getReader()
    const expected = range.end - range.start + 1
    const chunks: Uint8Array[] = []
    let loaded = 0
    try {
      while (true) {
        const item = await waitFor(
          reader.read(),
          this.stallTimeoutMs,
          request.signal,
          () => attemptController.abort(),
        )
        if (item.done) break
        chunks.push(item.value)
        loaded += item.value.byteLength
        if (loaded > expected) {
          throw new Error(`Zu viele Daten f\u00fcr den Bereich ab ${range.start}.`)
        }
        this.reportActivity({
          url: request.url,
          loaded: range.start + loaded,
          total: range.total,
        })
      }
    } catch (error) {
      if (!attemptController.signal.aborted) attemptController.abort(error)
      void reader.cancel(error).catch(() => undefined)
      throw error
    }

    if (loaded !== expected) {
      throw new Error(
        `Unvollst\u00e4ndiger Downloadbereich: ${loaded} von ${expected} Bytes empfangen.`,
      )
    }
    const result = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }

  private async fetchRange(
    request: Request,
    start: number,
    end: number,
    expectedTotal?: number,
  ): Promise<
    RangeResponse | FullObjectResponse | Response | typeof DIRECT_FALLBACK
  > {
    return this.withRetries(
      request,
      async (attemptController, signal, finalAttempt) => {
        const headers = new Headers(request.headers)
        headers.set("range", `bytes=${start}-${end}`)
        const rangeRequest = new Request(request, { headers, signal })
        const response = await this.fetchAttempt(
          rangeRequest,
          signal,
          attemptController,
        )

        if (response.status !== 206) {
          if (start === 0) {
            if (retryableStatus(response.status) && !finalAttempt) {
              void response.body?.cancel().catch(() => undefined)
              throw new Error(`HTTP ${response.status} f\u00fcr ${request.url}`)
            }
            return this.bufferResponse(
              response,
              rangeRequest,
              signal,
              attemptController,
              response.ok ? expectedTotal : undefined,
            )
          }
          if (response.status === 200 && expectedTotal !== undefined) {
            const fullResponse = await this.bufferResponse(
              response,
              rangeRequest,
              signal,
              attemptController,
              expectedTotal,
            )
            return {
              kind: "full-object",
              response: fullResponse,
              total: expectedTotal,
            }
          }
          void response.body?.cancel().catch(() => undefined)
          const message =
            `HTTP ${response.status} statt eines Byte-Bereichs f\u00fcr ${request.url}`
          throw retryableStatus(response.status)
            ? new Error(message)
            : new NonRetryableDownloadError(message)
        }

        const encoding = response.headers
          .get("content-encoding")
          ?.trim()
          .toLowerCase()
        const range = parseContentRange(response.headers.get("content-range"))
        if (
          (encoding && encoding !== "identity") ||
          !range ||
          range.start !== start ||
          range.end > end
        ) {
          void response.body?.cancel().catch(() => undefined)
          if (start === 0) return DIRECT_FALLBACK
          throw new NonRetryableDownloadError(
            `Ung\u00fcltige Byte-Bereichsantwort f\u00fcr ${request.url}`,
          )
        }
        const bytes = await this.readRange(
          response,
          rangeRequest,
          range,
          attemptController,
        )
        return { response, bytes, ...range }
      },
    )
  }

  private async fetchChunked(
    request: Request,
    expectedByteLength?: number,
  ): Promise<Response> {
    const first = await this.fetchRange(
      request,
      0,
      this.chunkSizeBytes - 1,
      expectedByteLength,
    )
    if (first === DIRECT_FALLBACK) {
      return this.fetchDirect(request, expectedByteLength)
    }
    if (first instanceof Response) return first
    if (isFullObjectResponse(first)) return first.response
    if (
      expectedByteLength !== undefined &&
      first.total !== expectedByteLength
    ) {
      throw new NonRetryableDownloadError(
        "Unerwartete Downloadgröße: " +
          first.total +
          " statt " +
          expectedByteLength +
          " Bytes.",
      )
    }

    const streamController = new AbortController()
    const signal = combinedSignal([request.signal, streamController.signal])!
    const retainPrefix = expectedByteLength !== undefined
    let offset = 0
    let firstChunk: Uint8Array | null = first.bytes
    let emittedChunks: Uint8Array[] = []
    let fullObject:
      | {
          reader: ReadableStreamDefaultReader<Uint8Array>
          loaded: number
          prefixChunkIndex: number
          prefixByteIndex: number
          skipUntil: number
          total: number
        }
      | undefined
    let finished = false

    const comparePrefix = (bytes: Uint8Array): boolean => {
      if (!fullObject) return false
      let index = 0
      while (index < bytes.byteLength) {
        const expected = emittedChunks[fullObject.prefixChunkIndex]
        if (!expected) return false
        const count = Math.min(
          bytes.byteLength - index,
          expected.byteLength - fullObject.prefixByteIndex,
        )
        for (let position = 0; position < count; position += 1) {
          if (
            bytes[index + position] !==
            expected[fullObject.prefixByteIndex + position]
          ) {
            return false
          }
        }
        index += count
        fullObject.prefixByteIndex += count
        if (fullObject.prefixByteIndex >= expected.byteLength) {
          fullObject.prefixChunkIndex += 1
          fullObject.prefixByteIndex = 0
        }
      }
      return true
    }

    const pullFullObject = async (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ): Promise<void> => {
      if (!fullObject) return
      const item = await fullObject.reader.read()
      if (item.done) {
        if (fullObject.loaded !== fullObject.total || offset !== fullObject.total) {
          throw new Error(
            "Unvollständiger Voll-Download: " +
              fullObject.loaded +
              " von " +
              fullObject.total +
              " Bytes empfangen.",
          )
        }
        finished = true
        emittedChunks = []
        fullObject.reader.releaseLock()
        controller.close()
        return
      }

      const nextLoaded = fullObject.loaded + item.value.byteLength
      if (nextLoaded > fullObject.total) {
        throw new Error(
          "Zu viele Daten im Voll-Download: " +
            nextLoaded +
            " statt " +
            fullObject.total +
            " Bytes empfangen.",
        )
      }
      const prefixBytes = Math.max(
        0,
        Math.min(item.value.byteLength, fullObject.skipUntil - fullObject.loaded),
      )
      if (
        prefixBytes > 0 &&
        !comparePrefix(item.value.subarray(0, prefixBytes))
      ) {
        throw new NonRetryableDownloadError(
          "Der Voll-Download stimmt nicht mit den bereits geladenen Bytes überein.",
        )
      }
      fullObject.loaded = nextLoaded
      if (fullObject.loaded >= fullObject.skipUntil) emittedChunks = []

      const suffix = item.value.subarray(prefixBytes)
      if (suffix.byteLength > 0) {
        offset += suffix.byteLength
        controller.enqueue(suffix)
      }
      this.reportActivity({
        url: request.url,
        loaded: Math.max(offset, fullObject.loaded),
        total: fullObject.total,
      })
    }

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (finished) return
        try {
          throwIfAborted(signal)
          if (fullObject) {
            await pullFullObject(controller)
          } else if (firstChunk) {
            const bytes = firstChunk
            firstChunk = null
            offset = bytes.byteLength
            if (retainPrefix) emittedChunks.push(bytes)
            controller.enqueue(bytes)
          } else if (offset < first.total) {
            const next = await this.fetchRange(
              new Request(request, { signal }),
              offset,
              Math.min(offset + this.chunkSizeBytes - 1, first.total - 1),
              expectedByteLength,
            )
            if (
              next === DIRECT_FALLBACK ||
              next instanceof Response ||
              next.total !== first.total
            ) {
              throw new Error(`Der Server hat den Byte-Download unerwartet beendet.`)
            }
            if (isFullObjectResponse(next)) {
              if (!next.response.body) {
                throw new Error("Leere Voll-Download-Antwort für " + request.url)
              }
              fullObject = {
                reader: next.response.body.getReader(),
                loaded: 0,
                prefixChunkIndex: 0,
                prefixByteIndex: 0,
                skipUntil: offset,
                total: first.total,
              }
              await pullFullObject(controller)
            } else {
              offset = next.end + 1
              if (retainPrefix) emittedChunks.push(next.bytes)
              controller.enqueue(next.bytes)
            }
          }
          if (!fullObject && offset >= first.total) {
            finished = true
            emittedChunks = []
            controller.close()
          }
        } catch (error) {
          finished = true
          void fullObject?.reader.cancel(error).catch(() => undefined)
          controller.error(error)
        }
      },
      cancel: (reason) => {
        finished = true
        emittedChunks = []
        void fullObject?.reader.cancel(reason).catch(() => undefined)
        streamController.abort(reason)
      },
    })

    const headers = new Headers(first.response.headers)
    headers.delete("content-range")
    headers.delete("content-encoding")
    headers.set("accept-ranges", "bytes")
    headers.set("content-length", String(first.total))
    return new Response(stream, {
      status: 200,
      statusText: "OK",
      headers,
    })
  }
}
