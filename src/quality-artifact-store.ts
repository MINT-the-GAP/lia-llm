const OPFS_ROOT_DIRECTORY = "tvmjs-opfs-store"
const VERIFIED_BYTES_HEADER = "x-lia-llm-verified-bytes"
const BINARY_VALIDATION_HEADER = "x-lia-llm-binary-validation"

export type QualityArtifactBackend = "cache" | "opfs"

export interface QualityArtifactStore {
  readonly backend: QualityArtifactBackend
  readonly scope: string
  match(input: RequestInfo | URL): Promise<Response | undefined>
  put(input: RequestInfo | URL, response: Response): Promise<void>
  delete(input: RequestInfo | URL): Promise<boolean>
  keys(): Promise<string[]>
}

interface OpfsMetadata {
  readonly url: string
  readonly contentType?: string
  readonly byteLength: number
  readonly verifiedBytes?: string
  readonly binaryValidation?: string
}

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>
}

function storageManager(): StorageManagerWithDirectory | undefined {
  if (typeof navigator === "undefined") return undefined
  return navigator.storage as StorageManagerWithDirectory | undefined
}

export function supportsQualityOpfs(): boolean {
  const storage = storageManager()
  return (
    typeof storage?.getDirectory === "function" &&
    typeof crypto !== "undefined" &&
    typeof crypto.subtle?.digest === "function"
  )
}

export function preferredQualityArtifactBackend(): QualityArtifactBackend {
  return supportsQualityOpfs() ? "opfs" : "cache"
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input).href
  if (input instanceof URL) return input.href
  return input.url
}

class CacheQualityArtifactStore implements QualityArtifactStore {
  readonly backend = "cache" as const
  readonly scope: string
  private readonly cache: Cache

  constructor(
    scope: string,
    cache: Cache,
  ) {
    this.scope = scope
    this.cache = cache
  }

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    return this.cache.match(input)
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    await this.cache.put(input, response)
  }

  delete(input: RequestInfo | URL): Promise<boolean> {
    return this.cache.delete(input)
  }

  async keys(): Promise<string[]> {
    return (await this.cache.keys()).map((request) => request.url)
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "NotFoundError"
  )
}

async function fileHandleIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | undefined> {
  try {
    return await directory.getFileHandle(name)
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}

async function removeIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.removeEntry(name)
    return true
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

function validMetadata(value: unknown, url: string): OpfsMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  const candidate = value as Partial<OpfsMetadata>
  if (
    candidate.url !== url ||
    typeof candidate.byteLength !== "number" ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength < 0
  ) {
    return null
  }
  if (
    candidate.contentType !== undefined &&
    typeof candidate.contentType !== "string"
  ) {
    return null
  }
  if (
    candidate.verifiedBytes !== undefined &&
    typeof candidate.verifiedBytes !== "string"
  ) {
    return null
  }
  if (
    candidate.binaryValidation !== undefined &&
    typeof candidate.binaryValidation !== "string"
  ) {
    return null
  }
  return candidate as OpfsMetadata
}

class OpfsQualityArtifactStore implements QualityArtifactStore {
  readonly backend = "opfs" as const
  readonly scope: string
  private directoryPromise?: Promise<FileSystemDirectoryHandle>

  constructor(scope: string) {
    this.scope = scope
  }

  private async directory(): Promise<FileSystemDirectoryHandle> {
    if (this.directoryPromise) return this.directoryPromise
    this.directoryPromise = (async () => {
      const storage = storageManager()
      if (typeof storage?.getDirectory !== "function") {
        throw new DOMException(
          "Der Origin Private File System-Speicher ist nicht verfuegbar.",
          "NotSupportedError",
        )
      }
      let directory = await storage.getDirectory()
      directory = await directory.getDirectoryHandle(OPFS_ROOT_DIRECTORY, {
        create: true,
      })
      for (const part of this.scope.split("/").filter(Boolean)) {
        directory = await directory.getDirectoryHandle(
          encodeURIComponent(part),
          { create: true },
        )
      }
      return directory
    })()
    return this.directoryPromise
  }

  private async baseName(url: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(url),
    )
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }

  private async names(input: RequestInfo | URL): Promise<{
    directory: FileSystemDirectoryHandle
    url: string
    data: string
    metadata: string
  }> {
    const url = requestUrl(input)
    const [directory, baseName] = await Promise.all([
      this.directory(),
      this.baseName(url),
    ])
    return {
      directory,
      url,
      data: baseName + ".bin",
      metadata: baseName + ".meta.json",
    }
  }

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const names = await this.names(input)
    const [dataHandle, metadataHandle] = await Promise.all([
      fileHandleIfPresent(names.directory, names.data),
      fileHandleIfPresent(names.directory, names.metadata),
    ])
    if (!dataHandle || !metadataHandle) {
      if (dataHandle || metadataHandle) await this.delete(input)
      return undefined
    }

    try {
      const [file, metadataText] = await Promise.all([
        dataHandle.getFile(),
        metadataHandle.getFile().then((file) => file.text()),
      ])
      const metadata = validMetadata(JSON.parse(metadataText), names.url)
      if (!metadata || metadata.byteLength !== file.size) {
        await this.delete(input)
        return undefined
      }
      const headers = new Headers()
      headers.set("content-length", String(file.size))
      if (metadata.contentType) {
        headers.set("content-type", metadata.contentType)
      }
      if (metadata.verifiedBytes) {
        headers.set(VERIFIED_BYTES_HEADER, metadata.verifiedBytes)
      }
      if (metadata.binaryValidation) {
        headers.set(BINARY_VALIDATION_HEADER, metadata.binaryValidation)
      }
      return new Response(file, { status: 200, headers })
    } catch (error) {
      await this.delete(input).catch(() => false)
      if (error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const names = await this.names(input)
    const contentLength = response.headers.get("content-length")
    const expectedBytes =
      contentLength && /^\d+$/u.test(contentLength)
        ? Number.parseInt(contentLength, 10)
        : undefined
    try {
      await removeIfPresent(names.directory, names.metadata)
      const dataHandle = await names.directory.getFileHandle(names.data, {
        create: true,
      })
      const writable = await dataHandle.createWritable()
      try {
        if (response.body) await response.body.pipeTo(writable)
        else {
          await writable.write(await response.arrayBuffer())
          await writable.close()
        }
      } catch (error) {
        await writable.abort(error).catch(() => undefined)
        throw error
      }

      const stored = await dataHandle.getFile()
      if (expectedBytes !== undefined && stored.size !== expectedBytes) {
        throw new Error(
          "Unvollstaendiger OPFS-Schreibvorgang: " +
            stored.size + " von " + expectedBytes + " Bytes gespeichert.",
        )
      }
      await this.writeMetadata(names, response, stored.size)
    } catch (error) {
      await Promise.allSettled([
        removeIfPresent(names.directory, names.data),
        removeIfPresent(names.directory, names.metadata),
      ])
      throw error
    }
  }

  private async writeMetadata(
    names: Awaited<ReturnType<OpfsQualityArtifactStore["names"]>>,
    response: Response,
    byteLength: number,
  ): Promise<void> {
    const metadata: OpfsMetadata = {
      url: names.url,
      contentType: response.headers.get("content-type") ?? undefined,
      byteLength,
      verifiedBytes: response.headers.get(VERIFIED_BYTES_HEADER) ?? undefined,
      binaryValidation:
        response.headers.get(BINARY_VALIDATION_HEADER) ?? undefined,
    }
    const handle = await names.directory.getFileHandle(names.metadata, {
      create: true,
    })
    const writable = await handle.createWritable()
    try {
      await writable.write(JSON.stringify(metadata))
      await writable.close()
    } catch (error) {
      await writable.abort(error).catch(() => undefined)
      throw error
    }
  }

  async delete(input: RequestInfo | URL): Promise<boolean> {
    const names = await this.names(input)
    const deleted = await Promise.all([
      removeIfPresent(names.directory, names.data),
      removeIfPresent(names.directory, names.metadata),
    ])
    return deleted.some(Boolean)
  }

  async keys(): Promise<string[]> {
    const directory = await this.directory()
    const urls: string[] = []
    const entries = (
      directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>
      }
    ).entries()
    for await (const [name, handle] of entries) {
      if (handle.kind !== "file" || !name.endsWith(".meta.json")) continue
      try {
        const file = await (handle as FileSystemFileHandle).getFile()
        const value = JSON.parse(await file.text())
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as { url?: unknown }).url === "string"
        ) {
          urls.push((value as { url: string }).url)
        }
      } catch {
        // Invalid metadata is ignored here and removed on the next direct probe.
      }
    }
    return urls
  }
}

export async function openQualityArtifactStore(
  scope: string,
  backend: QualityArtifactBackend,
): Promise<QualityArtifactStore> {
  if (backend === "opfs") {
    const store = new OpfsQualityArtifactStore(scope)
    // Fail now so callers can fall back before committing to this backend.
    await store.match("https://lia-llm.invalid/opfs-capability-probe")
    return store
  }
  if (typeof caches === "undefined") {
    throw new DOMException(
      "Dieser Browser unterstuetzt keinen CacheStorage-Modellcache.",
      "NotSupportedError",
    )
  }
  return new CacheQualityArtifactStore(scope, await caches.open(scope))
}
