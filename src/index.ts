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
import { getQuizReference, renderQuizSolution, runQuiz, stopQuiz } from "./quiz-runtime.ts"
import { QualityEvaluator } from "./quality-evaluator.ts"
import {
  parseCriteria,
  parseCriteriaBlock,
  parseReferenceVariants,
} from "./scoring.ts"
import {
  clearSolutionVariant,
  getSolutionVariant,
  registerResultSeparatorElement,
  registerSolutionElement,
  setSolutionVariant,
  showSolution,
} from "./solution-element.ts"
import type { LiaLLMApi } from "./types.ts"

const VERSION = "0.6.6"

interface LiaLLMGlobal {
  LiaLLM?: LiaLLMApi
  __liaLlmQuizCheckCaptureInstalled?: boolean
  __liaLlmLastQuizCheckActivation?: {
    button: HTMLButtonElement
    observedAt: number
  }
}

const root = globalThis as typeof globalThis & LiaLLMGlobal

if (
  typeof document !== "undefined" &&
  typeof HTMLButtonElement !== "undefined" &&
  !root.__liaLlmQuizCheckCaptureInstalled
) {
  root.__liaLlmQuizCheckCaptureInstalled = true
  document.addEventListener(
    "click",
    (event) => {
      const path = typeof event.composedPath === "function"
        ? event.composedPath()
        : [event.target]
      const button = path.find(
        (candidate): candidate is HTMLButtonElement =>
          candidate instanceof HTMLButtonElement &&
          candidate.classList.contains("lia-quiz__check"),
      )
      if (button) {
        root.__liaLlmLastQuizCheckActivation = {
          button,
          observedAt: Date.now(),
        }
      }
    },
    true,
  )
}

let api = root.LiaLLM

if (!api) {
  const evaluator = new AutomaticEvaluator()

  api = {
    version: VERSION,
    getQuizReference,
    runQuiz: (...args) => runQuiz(activeApi, ...args),
    renderQuizSolution: (...args) => renderQuizSolution(activeApi, ...args),
    configure: (config) => evaluator.configure(config),
    preload: () => evaluator.preload(),
    evaluate: (request, options) => evaluator.evaluate(request, options),
    evaluateLanguage: (request, options) =>
      evaluator.evaluateLanguage(request, options),
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
    parseCriteriaBlock,
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
registerQuizPresenceElement(
  () => {
    void activeApi.preload().catch(() => undefined)
  },
  stopQuiz,
)
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
  parseCriteriaBlock,
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
