import type {
  AssessmentEngine,
  ModelDownloadConsentDetail,
} from "./types.ts"

export const DOWNLOAD_CONSENT_EVENT = "lia-llm:download-consent"

export interface NetworkSnapshot {
  online: boolean
  saveData: boolean
  connectionType: string | null
  mobile: boolean
}

export type DownloadPolicyDecision = "auto" | "consent" | "skip"

export interface DownloadPolicyInput {
  engine: AssessmentEngine
  cached: boolean
  network: NetworkSnapshot
}

export interface DownloadConsentRequest {
  engine: AssessmentEngine
  modelName: string
  estimatedBytes: number
}

interface NetworkInformationLike {
  type?: string
  saveData?: boolean
}

interface NavigatorWithNetworkInformation extends Navigator {
  connection?: NetworkInformationLike
  userAgentData?: {
    mobile?: boolean
  }
}

const MOBILE_USER_AGENT =
  /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/iu

let consentSequence = 0

function currentNavigator(): Navigator | undefined {
  return typeof navigator === "undefined" ? undefined : navigator
}

export function captureNetworkSnapshot(
  source: Navigator | undefined = currentNavigator(),
): NetworkSnapshot {
  const extended = source as NavigatorWithNetworkInformation | undefined
  const connectionType =
    extended?.connection?.type?.trim().toLowerCase() || null
  const mobileHint = extended?.userAgentData?.mobile
  const mobile =
    typeof mobileHint === "boolean"
      ? mobileHint
      : MOBILE_USER_AGENT.test(extended?.userAgent ?? "")

  return {
    online: extended?.onLine !== false && connectionType !== "none",
    saveData: extended?.connection?.saveData === true,
    connectionType,
    mobile,
  }
}

export function decideModelDownload({
  engine,
  cached,
  network,
}: DownloadPolicyInput): DownloadPolicyDecision {
  if (cached) return "auto"
  if (!network.online) return "skip"
  if (
    network.saveData ||
    network.connectionType === "cellular" ||
    network.connectionType?.startsWith("cellular") === true
  ) {
    return "consent"
  }
  if (
    network.connectionType === "wifi" ||
    network.connectionType === "ethernet"
  ) {
    return "auto"
  }
  if (engine === "quality") return "consent"
  return network.mobile ? "consent" : "auto"
}

export function requestModelDownloadConsent(
  request: DownloadConsentRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    signal?.aborted ||
    typeof globalThis.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  ) {
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolve) => {
    let settled = false
    const abort = (): void => finish(false)
    const finish = (allow: boolean): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      resolve(Boolean(allow))
    }
    const detail: ModelDownloadConsentDetail = {
      ...request,
      id: `lia-llm-download-${++consentSequence}`,
      handled: false,
      signal,
      respond: finish,
    }

    signal?.addEventListener("abort", abort, { once: true })
    globalThis.dispatchEvent(
      new CustomEvent<ModelDownloadConsentDetail>(DOWNLOAD_CONSENT_EVENT, {
        detail,
      }),
    )

    queueMicrotask(() => {
      if (!detail.handled) finish(false)
    })
  })
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.storage?.persisted !== "function" ||
    typeof navigator.storage?.persist !== "function"
  ) {
    return false
  }

  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
