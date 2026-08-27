import type { AppConfig, ModelRecord } from "@mlc-ai/web-llm"

export interface QualityModelDefinition {
  readonly tier: "small" | "large"
  readonly id: string
  readonly revision: string
  readonly estimatedBytes: number
}

export const SMALL_QUALITY_MODEL = {
  tier: "small",
  id: "Qwen3-1.7B-q4f16_1-MLC",
  revision: "80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc",
  estimatedBytes: 984_000_000,
} as const satisfies QualityModelDefinition

export const LARGE_QUALITY_MODEL = {
  tier: "large",
  id: "Qwen3-4B-q4f16_1-MLC",
  revision: "a5c9fab855e3ccbdfed2e7e69683d75f30332161",
  estimatedBytes: 2_280_000_000,
} as const satisfies QualityModelDefinition

export const QUALITY_MODELS = [LARGE_QUALITY_MODEL, SMALL_QUALITY_MODEL] as const

// Keep the established constants as aliases for callers that explicitly use
// the conservative 1.7B default. Runtime selection may choose either model.
export const QUALITY_MODEL_ID = SMALL_QUALITY_MODEL.id
export const QUALITY_MODEL_REVISION = SMALL_QUALITY_MODEL.revision
export const QUALITY_MODEL_LIB_REVISION =
  "025bcaf3780fa8254f5e5efd3bfea0a5397248f4"
export const QUALITY_MODEL_ESTIMATED_BYTES = SMALL_QUALITY_MODEL.estimatedBytes
export const LEGACY_QUALITY_CACHE_TARGETS = [
  {
    modelUrl:
      "https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC/resolve/" +
      "8c14ce481d4c692769976ad52afea453a102df19/",
    modelLibUrl:
      "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/" +
      QUALITY_MODEL_LIB_REVISION +
      "/web-llm-models/v0_2_84/base/Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm",
  },
] as const

function pinnedModelLib(source: string): string {
  const url = new URL(source)
  const mutablePrefix = "/mlc-ai/binary-mlc-llm-libs/main/"
  if (
    url.hostname !== "raw.githubusercontent.com" ||
    !url.pathname.startsWith(mutablePrefix)
  ) {
    throw new Error(
      "Die WebLLM-Laufzeit verweist nicht auf das erwartete MLC-Artefakt.",
    )
  }
  url.pathname =
    `/mlc-ai/binary-mlc-llm-libs/${QUALITY_MODEL_LIB_REVISION}/` +
    url.pathname.slice(mutablePrefix.length)
  return url.href
}

function pinnedModelRecord(
  prebuiltAppConfig: AppConfig,
  model: QualityModelDefinition,
): ModelRecord {
  const record = prebuiltAppConfig.model_list.find(
    (candidate) => candidate.model_id === model.id,
  )
  if (!record) {
    throw new Error(
      `WebLLM enthält keine Konfiguration für ${model.id}.`,
    )
  }

  return {
    ...record,
    model:
      `https://huggingface.co/mlc-ai/${model.id}/resolve/` +
      `${model.revision}/`,
    model_lib: pinnedModelLib(record.model_lib),
  }
}

export function createQualityAppConfig(
  prebuiltAppConfig: AppConfig,
  model: QualityModelDefinition = SMALL_QUALITY_MODEL,
): AppConfig {
  return {
    ...prebuiltAppConfig,
    cacheBackend: "cache",
    model_list: [pinnedModelRecord(prebuiltAppConfig, model)],
  }
}
