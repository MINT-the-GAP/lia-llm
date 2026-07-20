export const NLI_TASK = "zero-shot-classification" as const

export const DEFAULT_MODEL_ID =
  "Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7"
export const DEFAULT_MODEL_REVISION = "0864ced79bf1ef851bfaf9dd9de0aa54d735d9d0"
export const DEFAULT_MODEL_ESTIMATED_BYTES = 355_000_000
export const DEFAULT_NLI_BATCH_SIZE = 4
export const MAX_NLI_SEQUENCE_LENGTH = 512
export const MAX_NLI_PAIRS = 512

export const LEGACY_EMBEDDING_CACHE = {
  task: "feature-extraction",
  modelId: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  device: "wasm",
  dtype: "q8",
} as const

export const LEGACY_NLI_CACHE = {
  task: NLI_TASK,
  modelId:
    "onnx-community/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7-ONNX",
  revision: "cdc8277b4682665e2f2e87cd83da7da07b153d75",
  device: "wasm",
  dtype: "q8",
} as const
