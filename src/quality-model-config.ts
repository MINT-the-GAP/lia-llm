import type { AppConfig, ModelRecord } from "@mlc-ai/web-llm"

export const QUALITY_MODEL_ID = "Qwen3-4B-q4f16_1-MLC"
export const QUALITY_MODEL_REVISION =
  "a5c9fab855e3ccbdfed2e7e69683d75f30332161"
export const QUALITY_MODEL_ESTIMATED_BYTES = 2_280_000_000

function pinnedModelRecord(prebuiltAppConfig: AppConfig): ModelRecord {
  const record = prebuiltAppConfig.model_list.find(
    (candidate) => candidate.model_id === QUALITY_MODEL_ID,
  )
  if (!record) {
    throw new Error(
      `WebLLM enthält keine Konfiguration für ${QUALITY_MODEL_ID}.`,
    )
  }

  return {
    ...record,
    model:
      `https://huggingface.co/mlc-ai/${QUALITY_MODEL_ID}/resolve/` +
      `${QUALITY_MODEL_REVISION}/`,
  }
}

export function createQualityAppConfig(
  prebuiltAppConfig: AppConfig,
): AppConfig {
  return {
    ...prebuiltAppConfig,
    cacheBackend: "cache",
    model_list: [pinnedModelRecord(prebuiltAppConfig)],
  }
}
