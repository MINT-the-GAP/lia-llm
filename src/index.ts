import {
  registerActivityElement,
  showActivity,
} from "./activity-element.ts"
import { AutomaticEvaluator } from "./automatic-evaluator.ts"
import {
  createDebugReport,
  registerDebugDiagnostics,
} from "./debug-diagnostics.ts"
import { SemanticEvaluator } from "./evaluator.ts"
import { registerFeedbackElement, showFeedback } from "./feedback-element.ts"
import { formatResult } from "./format.ts"
import {
  EvaluationInputError,
  feedbackForError,
  feedbackForResult,
} from "./learner-feedback.ts"
import { registerLoadOverlay } from "./load-overlay.ts"
import { parseMacroOptions } from "./macro-options.ts"
import { registerQuizTextareas } from "./quiz-textarea.ts"
import { registerQuizPresenceElement } from "./quiz-presence-element.ts"
import { QualityEvaluator } from "./quality-evaluator.ts"
import { parseCriteria, parseReferenceVariants } from "./scoring.ts"
import {
  clearSolutionVariant,
  getSolutionVariant,
  registerResultSeparatorElement,
  registerSolutionElement,
  setSolutionVariant,
  showSolution,
} from "./solution-element.ts"
import type { LiaLLMApi } from "./types.ts"

const VERSION = "0.5.11"

interface LiaLLMGlobal {
  LiaLLM?: LiaLLMApi
}

const root = globalThis as typeof globalThis & LiaLLMGlobal
let api = root.LiaLLM

if (!api) {
  const evaluator = new AutomaticEvaluator()

  api = {
    version: VERSION,
    configure: (config) => evaluator.configure(config),
    preload: () => evaluator.preload(),
    evaluate: (request, options) => evaluator.evaluate(request, options),
    getStatus: () => evaluator.getStatus(),
    getCacheInfo: () => evaluator.getCacheInfo(),
    debugReport: (options) =>
      createDebugReport(
        {
          version: VERSION,
          getStatus: () => evaluator.getStatus(),
          getCacheInfo: () => evaluator.getCacheInfo(),
        },
        options,
      ),
    clearCache: () => evaluator.clearCache(),
    parseCriteria,
    parseReferenceVariants,
    parseMacroOptions,
    formatResult,
    feedbackForResult,
    feedbackForError,
    showActivity,
    showFeedback,
    showSolution,
    setSolutionVariant,
    getSolutionVariant,
    clearSolutionVariant,
  }
  root.LiaLLM = api
} else if (api.version !== VERSION) {
  console.warn(`lia-llm ${api.version} ist bereits geladen; ${VERSION} wird nicht zusätzlich initialisiert.`)
}

const activeApi = api as LiaLLMApi
registerDebugDiagnostics(activeApi)
registerLoadOverlay(activeApi)
registerQuizTextareas()
registerActivityElement()
registerQuizPresenceElement(() => {
  void activeApi.preload().catch(() => undefined)
})
registerFeedbackElement()
registerSolutionElement()
registerResultSeparatorElement()

export {
  AutomaticEvaluator,
  EvaluationInputError,
  feedbackForError,
  feedbackForResult,
  formatResult,
  parseMacroOptions,
  parseCriteria,
  parseReferenceVariants,
  QualityEvaluator,
  SemanticEvaluator,
  showActivity,
  clearSolutionVariant,
  getSolutionVariant,
  setSolutionVariant,
  showSolution,
}
export type * from "./types.ts"
