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
    const original = new Request(input, init)
    const signal = combinedSignal([original.signal, this.controller.signal])
    const request = new Request(original, { signal })
    throwIfAborted(signal)
    return this.shouldChunk(request)
      ? this.fetchChunked(request)
      : this.fetchDirect(request)
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
  ): Promise<Response> {
    const expected = expectedResponseBytes(response)
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

    return copyResponse(response, replayBody(chunks))
  }

  private async fetchDirect(request: Request): Promise<Response> {
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
  ): Promise<RangeResponse | Response | typeof DIRECT_FALLBACK> {
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
            )
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

  private async fetchChunked(request: Request): Promise<Response> {
    const first = await this.fetchRange(
      request,
      0,
      this.chunkSizeBytes - 1,
    )
    if (first === DIRECT_FALLBACK) return this.fetchDirect(request)
    if (first instanceof Response) return first

    const streamController = new AbortController()
    const signal = combinedSignal([request.signal, streamController.signal])!
    let offset = 0
    let firstChunk: Uint8Array | null = first.bytes
    let finished = false
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (finished) return
        try {
          throwIfAborted(signal)
          if (firstChunk) {
            const bytes = firstChunk
            firstChunk = null
            offset = bytes.byteLength
            controller.enqueue(bytes)
          } else if (offset < first.total) {
            const next = await this.fetchRange(
              new Request(request, { signal }),
              offset,
              Math.min(offset + this.chunkSizeBytes - 1, first.total - 1),
            )
            if (
              next === DIRECT_FALLBACK ||
              next instanceof Response ||
              next.total !== first.total
            ) {
              throw new Error(`Der Server hat den Byte-Download unerwartet beendet.`)
            }
            offset = next.end + 1
            controller.enqueue(next.bytes)
          }
          if (offset >= first.total) {
            finished = true
            controller.close()
          }
        } catch (error) {
          finished = true
          controller.error(error)
        }
      },
      cancel: (reason) => {
        finished = true
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
