import { SemanticEvaluator } from "./evaluator.ts"
import { registerFeedbackElement, showFeedback } from "./feedback-element.ts"
import { formatResult } from "./format.ts"
import { registerLoadOverlay } from "./load-overlay.ts"
import { registerQuizTextareas } from "./quiz-textarea.ts"
import { parseCriteria } from "./scoring.ts"
import type { LiaLLMApi } from "./types.ts"

const VERSION = "0.3.1"

interface LiaLLMGlobal {
  LiaLLM?: LiaLLMApi
}

const root = globalThis as typeof globalThis & LiaLLMGlobal
let api = root.LiaLLM

if (!api) {
  const evaluator = new SemanticEvaluator()
  api = {
    version: VERSION,
    configure: (config) => evaluator.configure(config),
    preload: () => evaluator.preload(),
    evaluate: (request) => evaluator.evaluate(request),
    getStatus: () => evaluator.getStatus(),
    getCacheInfo: () => evaluator.getCacheInfo(),
    clearCache: () => evaluator.clearCache(),
    parseCriteria,
    formatResult,
    showFeedback,
  }
  root.LiaLLM = api
} else if (api.version !== VERSION) {
  console.warn(`lia-llm ${api.version} ist bereits geladen; ${VERSION} wird nicht zusätzlich initialisiert.`)
}

registerLoadOverlay(api)
registerQuizTextareas()
registerFeedbackElement()

export { formatResult, parseCriteria, SemanticEvaluator }
export type * from "./types.ts"
