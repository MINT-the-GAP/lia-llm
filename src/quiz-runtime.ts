import type { LLMQuizMacroOptions } from "./macro-options.ts"
import { fromQuizInputValue, quizForHost } from "./quiz-textarea.ts"
import type {
  CriterionInput,
  FeedbackLanguageCheckRequest,
  LearnerFeedback,
  LiaLLMApi,
  LiaQuizSend,
  LiaQuizSolutionSend,
  ParsedCriteriaBlock,
} from "./types.ts"

interface QuizRuntimeGlobal {
  __liaLlmLastQuizCheckActivation?: { button: HTMLButtonElement; observedAt: number }
  __liaLlmActiveQuizRuns?: Map<string, () => void>
}

// Keep the completed session alive for the optional language check. A new
// attempt, LiaScript stop/reset, or a disconnected quiz retires it as well.
const quizSessions = new Map<string, () => void>()
const quizReferences = new Map<string, string>()

// The reactive solution script runs on initial display, including unsolved
// quizzes. Store the authored source there once instead of expanding a second
// copy into the validator. Keep it available for restored quiz results.
export function getQuizReference(id: string): string {
  const source = quizReferences.get(id)
  if (source === undefined) {
    throw new Error("Die Quiz-Referenz wurde noch nicht initialisiert.")
  }
  return source
}

export function stopQuiz(id: string): void {
  quizSessions.get(`lia-llm-activity-${id}`)?.()
}

/** Shared implementation: the macro only supplies authored data and send. */
export function runQuiz(
  api: LiaLLMApi,
  id: string,
  optionSource: string,
  question: string,
  referenceSource: string,
  input: string,
  send: LiaQuizSend,
): "LIA: wait" {
  const root = (typeof window === "undefined" ? globalThis : window) as
    typeof globalThis & QuizRuntimeGlobal
  const feedbackId = `lia-llm-feedback-${id}`
  const activityId = `lia-llm-activity-${id}`
  const solutionVariantId = `lia-llm-solution-variant-${id}`
  const runId = activityId + "-" + Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2)
  const evaluationController = new AbortController()
  const rememberedCheckActivation = root.__liaLlmLastQuizCheckActivation
  if (rememberedCheckActivation) {
    delete root.__liaLlmLastQuizCheckActivation
  }
  const activeCheckButton =
    typeof document !== "undefined" &&
    typeof HTMLButtonElement !== "undefined" &&
    document.activeElement instanceof HTMLButtonElement &&
    document.activeElement.classList.contains("lia-quiz__check")
      ? document.activeElement
      : typeof HTMLButtonElement !== "undefined" &&
          rememberedCheckActivation?.button instanceof HTMLButtonElement &&
          rememberedCheckActivation.button.isConnected &&
          Date.now() - rememberedCheckActivation.observedAt < 2000
        ? rememberedCheckActivation.button
        : null
  let checkButtonInitialDisabled = false
  let checkButtonInitialAriaBusy: string | null = null
  const activeQuizRuns =
    root.__liaLlmActiveQuizRuns instanceof Map
      ? root.__liaLlmActiveQuizRuns
      : new Map()
  root.__liaLlmActiveQuizRuns = activeQuizRuns
  const answer = input.replace(/\u2028/gu, "\n")
  let active = true
  let finished = false
  let feedbackEnabled = false
  let referenceVariants: string[] = []
  let criteriaBlock: ParsedCriteriaBlock | null = null
  let evaluationCriteria: CriterionInput[] | undefined
  let evaluationThresholds: {
    criterionThreshold: number
    passThreshold?: number
  } | null = null
  let quizOptions: LLMQuizMacroOptions | null = null

  function clearActivity() {
    try {
      api?.showActivity?.(activityId, runId, "")
    } catch {}
  }

  function clearSolutionVariant() {
    try {
      api?.clearSolutionVariant?.(solutionVariantId, runId)
    } catch {}
  }

  function setCheckButtonBusy(busy: boolean) {
    if (!activeCheckButton?.isConnected) return
    activeCheckButton.disabled = busy || checkButtonInitialDisabled
    if (busy) {
      activeCheckButton.setAttribute("aria-busy", "true")
    } else if (checkButtonInitialAriaBusy === null) {
      activeCheckButton.removeAttribute("aria-busy")
    } else {
      activeCheckButton.setAttribute("aria-busy", checkButtonInitialAriaBusy)
    }
  }

  function releaseQuizRun() {
    if (activeQuizRuns.get(activityId) !== supersedeEvaluation) return
    activeQuizRuns.delete(activityId)
    try {
      setCheckButtonBusy(false)
    } catch {}
  }

  function showLearnerFeedback(
    feedback: LearnerFeedback | null,
    languageCheck?: FeedbackLanguageCheckRequest,
  ) {
    if (!active) return
    const visibleFeedback = feedbackEnabled ? feedback : null
    const displayOptions =
      visibleFeedback?.orthographyCorrection || languageCheck
        ? {
            ...(visibleFeedback?.orthographyCorrection
              ? { orthographyCorrection: visibleFeedback.orthographyCorrection }
              : {}),
            ...(languageCheck ? { languageCheck } : {})
          }
        : undefined
    try {
      api?.showFeedback?.(
        feedbackId,
        visibleFeedback?.message ?? "",
        displayOptions
      )
    } catch {}
  }

  function stoppedError() {
    const error = new Error("Die Sprachprüfung wurde beendet.")
    error.name = "AbortError"
    return error
  }

  function finishQuiz(value: string) {
    if (!active || finished) return
    finished = true
    releaseQuizRun()
    clearActivity()
    send.lia(value)
  }

  function finishUnassessed(message: string) {
    if (!active || finished) return
    finished = true
    releaseQuizRun()
    clearActivity()
    clearSolutionVariant()
    try {
      api?.showFeedback?.(feedbackId, "")
    } catch {}
    send.lia(message, [], false)
  }

  function finishTechnicalError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    finishUnassessed(message)
  }

  function abortEvaluation() {
    if (!active) return false
    const wasWaiting = !finished
    active = false
    finished = true
    evaluationController.abort()
    releaseQuizRun()
    clearActivity()
    // LiaScript restores completed results when revisiting a slide. Preserve
    // their reference choice; a new attempt establishes its own selection.
    if (wasWaiting) clearSolutionVariant()
    try {
      api?.showFeedback?.(feedbackId, "")
    } catch {}
    if (quizSessions.get(activityId) === supersedeEvaluation) {
      quizSessions.delete(activityId)
    }
    return wasWaiting
  }

  function restoreCheckButtonFocus() {
    if (activeCheckButton?.isConnected && !activeCheckButton.disabled) {
      try {
        activeCheckButton.focus({ preventScroll: true })
      } catch {}
    }
  }

  function stopEvaluation() {
    abortEvaluation()
  }

  function stopWaitingState() {
    if (typeof send.stop === "function") send.stop()
    else send.lia("LIA: stop")
  }

  function supersedeEvaluation() {
    if (!abortEvaluation()) return
    stopWaitingState()
  }

  function cancelEvaluation() {
    if (!abortEvaluation()) return
    stopWaitingState()
    restoreCheckButtonFocus()
    if (typeof queueMicrotask === "function") {
      queueMicrotask(restoreCheckButtonFocus)
    }
  }

  // Register before the first microtask so an immediate reset cannot start a run.
  quizSessions.get(activityId)?.()
  quizSessions.set(activityId, supersedeEvaluation)
  send.handle("stop", stopEvaluation)

  void Promise.resolve()
    .then(() => {
      if (!active) return
      const previousQuizRun = activeQuizRuns.get(activityId)
      if (typeof previousQuizRun === "function") previousQuizRun()
      checkButtonInitialDisabled = activeCheckButton?.disabled ?? false
      checkButtonInitialAriaBusy =
        activeCheckButton?.getAttribute("aria-busy") ?? null
      activeQuizRuns.set(activityId, supersedeEvaluation)
      setCheckButtonBusy(true)
      try {
        api?.showFeedback?.(feedbackId, "")
        api?.showActivity?.(
          activityId,
          runId,
          "selecting-model",
          { onCancel: cancelEvaluation }
        )
        api?.setSolutionVariant?.(solutionVariantId, runId)
      } catch {}

      const options = api.parseMacroOptions(optionSource)
      quizOptions = options
      criteriaBlock = api.parseCriteriaBlock(referenceSource) ?? null
      if (options.coverage !== undefined && !criteriaBlock) {
        throw new Error(
          "Die Option coverage ist nur mit einem Kriterienblock zulässig."
        )
      }
      evaluationCriteria =
        options.coverage === undefined
          ? criteriaBlock?.criteria
          : criteriaBlock!.criteria.map(criterion => ({
              ...criterion,
              required: false
            }))
      evaluationThresholds = {
        criterionThreshold: options.passThreshold,
        ...(options.coverage !== undefined
          ? { passThreshold: options.coverage }
          : {})
      }
      referenceVariants = api.parseReferenceVariants(
        criteriaBlock?.reference ?? referenceSource
      )
      feedbackEnabled = options.feedback
      if (criteriaBlock && options.operator) {
        throw new Error(
          "Der atomare Aussagenabgleich prüft Inhalte ohne technischen Operator. Entferne operator=...; das Operatorwort darf im Aufgabenwortlaut stehen bleiben."
        )
      }
      return api.evaluate({
        question,
        answer,
        reference: referenceVariants[0] ?? "",
        referenceVariants: referenceVariants.slice(1),
        assessmentEngine: options.assessmentEngine,
        operator: options.operator ?? undefined,
        criteria: evaluationCriteria,
        ...evaluationThresholds
      }, {
        signal: evaluationController.signal,
        maxThinkingTimeMs: options.maxThinkingTimeMs,
        maxThinkingTokens: options.maxThinkingTokens,
        onProgress: progress => {
          if (!active || finished) return
          api?.showActivity?.(activityId, runId, progress.phase, {
            message: progress.message,
            thinkingTimeLimitMs: progress.thinkingTimeLimitMs,
            thinkingTimeRemainingMs: progress.thinkingTimeRemainingMs,
            onCancel: cancelEvaluation
          })
        }
      })
    })
    .then(result => {
      if (!active || !result) return
      if (result.status === "uncertain") {
        const feedback =
          api?.feedbackForResult?.(result, "de-DE") ?? null
        finishUnassessed(
          feedback?.message ??
            "Die Antwort konnte gerade nicht eindeutig bewertet werden. Versuche die Prüfung erneut."
        )
        return
      }
      if (result.passed) {
        const selectedReferenceIndex =
          result.selectedReferenceIndex !== undefined &&
          Number.isInteger(result.selectedReferenceIndex) &&
          result.selectedReferenceIndex >= 0 &&
          result.selectedReferenceIndex < referenceVariants.length
            ? result.selectedReferenceIndex
            : 0
        try {
          api?.setSolutionVariant?.(
            solutionVariantId,
            runId,
            selectedReferenceIndex
          )
        } catch {}
      } else {
        clearSolutionVariant()
      }
      const feedback = feedbackEnabled
        ? api?.feedbackForResult?.(result, "de-DE") ?? null
        : null
      const languageCheck: FeedbackLanguageCheckRequest | undefined =
        feedbackEnabled &&
        quizOptions &&
        (quizOptions.rechtschreibung || quizOptions.satzbau)
          ? {
              runId,
              kind:
                quizOptions.rechtschreibung && quizOptions.satzbau
                  ? "language"
                  : quizOptions.rechtschreibung
                    ? "orthography"
                    : "syntax",
              run: async signal => {
                if (!active || signal.aborted) throw stoppedError()
                const languageAnalysis = await api.evaluateLanguage({
                  question,
                  answer,
                  reference: referenceVariants[0] ?? "",
                  referenceVariants: referenceVariants.slice(1),
                  assessmentEngine: "quality",
                  operator: quizOptions!.operator ?? undefined,
                  criteria: evaluationCriteria,
                  ...evaluationThresholds,
                  languageAnalysis: {
                    spelling: quizOptions!.rechtschreibung,
                    syntax: quizOptions!.satzbau
                  }
                }, { signal })
                if (!active || signal.aborted) throw stoppedError()
                const languageFeedback =
                  api.feedbackForResult(
                    { ...result, languageAnalysis },
                    "de-DE"
                  )
                return {
                  completed: languageAnalysis?.status === "completed",
                  message: languageFeedback?.message ?? "",
                  ...(languageFeedback?.orthographyCorrection
                    ? {
                        orthographyCorrection:
                          languageFeedback.orthographyCorrection
                      }
                    : {})
                }
              }
            }
            : undefined
      showLearnerFeedback(feedback, languageCheck)
      finishQuiz(result.status === "passed" ? "true" : "false")
    })
    .catch(error => {
      if (!active) return
      clearSolutionVariant()
      const feedback = api?.feedbackForError?.(error, "de-DE") ?? null
      if (feedback) {
        finishUnassessed(feedback.message)
        return
      }
      finishTechnicalError(error)
    })

  return "LIA: wait"
}

/** Keep the reactive result dependency in LiaScript, render its content here. */
export function renderQuizSolution(
  api: LiaLLMApi,
  id: string,
  optionSource: string,
  referenceSource: string,
  solutionResult: string,
  send: LiaQuizSolutionSend,
): void {
  quizReferences.set(id, referenceSource)
  const solutionOptions = api?.parseMacroOptions?.(optionSource)
  const solutionVariantId = `lia-llm-solution-variant-${id}`
  const solutionCriteriaBlock =
    api?.parseCriteriaBlock?.(referenceSource)
  const resultSeparator =
    "\n\n<lia-llm-result-separator></lia-llm-result-separator>"

  let passed = solutionResult === "true"
  if (!passed && solutionResult !== "false" && typeof document !== "undefined") {
    // On slide restoration the viewer can publish the saved answer instead of
    // the validator result (notably in Firefox). Only recover a passed display
    // when the owning native quiz is still solved and the output is its answer.
    // A reset/open quiz or a technical error must continue to clear the output.
    const host = document.getElementById(`lia-llm-quiz-${id}`)
    const quiz = host ? quizForHost(host) : null
    const input = quiz?.querySelector<HTMLInputElement>("input.lia-quiz__input")
    passed = Boolean(
      quiz?.classList.contains("solved") && input &&
      fromQuizInputValue(input.value) === fromQuizInputValue(solutionResult),
    )
  }

  if (passed && solutionOptions?.solution) {
    const solutionReferenceVariants =
      api.parseReferenceVariants(
        solutionCriteriaBlock?.reference ?? referenceSource
      )
    const storedReferenceIndex =
      api?.getSolutionVariant?.(solutionVariantId)
    const selectedReferenceIndex =
      storedReferenceIndex !== undefined &&
      Number.isInteger(storedReferenceIndex) &&
      storedReferenceIndex >= 0 &&
      storedReferenceIndex < solutionReferenceVariants.length
        ? storedReferenceIndex
        : 0
    send.liascript(
      solutionReferenceVariants[selectedReferenceIndex] + resultSeparator
    )
  } else if (passed || solutionResult === "false") {
    send.liascript(resultSeparator)
  } else {
    send.clear()
  }
}
