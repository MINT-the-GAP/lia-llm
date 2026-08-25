import type {
  EvaluationResult,
  LanguageAnalysisResult,
  LearnerFeedback,
  OperatorRubric,
} from "./types.ts"

export type EvaluationInputErrorCode = "answer-too-short"

export class EvaluationInputError extends Error {
  readonly code: EvaluationInputErrorCode
  readonly actualCharacters: number
  readonly minimumCharacters: number
  readonly operator: OperatorRubric | undefined
  readonly languageAnalysis: LanguageAnalysisResult | undefined

  constructor(
    code: EvaluationInputErrorCode,
    message: string,
    actualCharacters: number,
    minimumCharacters: number,
    operator?: OperatorRubric,
    languageAnalysis?: LanguageAnalysisResult,
  ) {
    super(message)
    this.name = "EvaluationInputError"
    this.code = code
    this.actualCharacters = actualCharacters
    this.minimumCharacters = minimumCharacters
    this.operator = operator
    this.languageAnalysis = languageAnalysis
  }
}

function isGerman(locale: string): boolean {
  return locale.toLowerCase().startsWith("de")
}

function missingOperatorCriterion(
  result: EvaluationResult,
): OperatorRubric["criteria"][number] | undefined {
  if (!result.operator) return undefined
  const missingIds = new Set(
    result.criteria
      .filter(
        (criterion) =>
          criterion.judgeFeedbackCode === "operator-not-met" &&
          (criterion.status === "missed" ||
            criterion.status === "contradicted"),
      )
      .map((criterion) => criterion.operatorCriterionId)
      .filter((id): id is string => Boolean(id)),
  )
  return [...result.operator.criteria]
    .filter((criterion) => missingIds.has(criterion.id))
    .sort((left, right) => right.priority - left.priority)[0]
}

function contentFeedbackForResult(
  result: EvaluationResult,
  locale = "de-DE",
): LearnerFeedback | null {
  const german = isGerman(locale)
  const diagnostic = result.diagnostic

  if (diagnostic?.code === "answer-too-short") {
    return {
      code: "answer-too-short",
      message: german
        ? result.operator?.tooShortFeedback.de ??
          "Die Antwort ist deutlich zu kurz, um die Aufgabe ausreichend zu bearbeiten."
        : result.operator?.tooShortFeedback.en ??
          "The answer is much too short to address the task adequately.",
    }
  }

  if (
    diagnostic?.code === "content-error" ||
    result.criteria.some((criterion) => criterion.status === "contradicted")
  ) {
    return {
      code: "content-error",
      message: german
        ? "Die Antwort enthält inhaltliche Fehler."
        : "The answer contains substantive errors.",
    }
  }

  if (
    diagnostic?.code === "off-topic" ||
    result.criteria.some(
      (criterion) => criterion.judgeDecision === "fail_off_topic",
    )
  ) {
    return {
      code: "off-topic",
      message: german
        ? "Die Antwort geht noch nicht auf die gestellte Frage ein."
        : "The answer does not address the question yet.",
    }
  }

  if (diagnostic?.code === "operator-check-unavailable") {
    return {
      code: "operator-check-unavailable",
      message: german
        ? "Die verlangte Antwortform konnte gerade nicht zuverlässig geprüft werden. Versuche die Prüfung erneut, sobald die Qualitätsprüfung verfügbar ist."
        : "The required response form could not be checked reliably. Try again when quality assessment is available.",
    }
  }

  if (diagnostic?.code === "operator-not-met") {
    const criterion = missingOperatorCriterion(result)
    return {
      code: "operator-not-met",
      message: german
        ? criterion?.feedback.de ??
          result.operator?.operatorFeedback.de ??
          "Die Antwort erfüllt die Anforderungen des Aufgabenoperators noch nicht."
        : criterion?.feedback.en ??
          result.operator?.operatorFeedback.en ??
          "The answer does not yet meet the task operator's requirements.",
    }
  }

  if (diagnostic?.code === "unclear" || result.status === "uncertain") {
    return {
      code: "unclear",
      message: german
        ? "Die Antwort ist noch nicht eindeutig genug. Formuliere den Zusammenhang klarer."
        : "The answer is not clear enough yet. State the relationship more precisely.",
    }
  }

  if (diagnostic?.code === "too-colloquial" && result.passed) {
    return {
      code: "too-colloquial",
      message: german
        ? "Die Antwort ist zu umgangssprachlich verfasst."
        : "The answer is phrased too colloquially.",
    }
  }

  if (result.passed) return null

  return {
    code: "incomplete",
    message: german
      ? "Die Antwort bearbeitet die gefragten Inhalte noch nicht vollständig."
      : "The answer does not yet address the requested content completely.",
  }
}

function languageFeedback(
  analysis: LanguageAnalysisResult | undefined,
  locale: string,
): LearnerFeedback | null {
  if (!analysis) return null

  const german = isGerman(locale)
  if (analysis.status === "unavailable") {
    return {
      code: "language-analysis-unavailable",
      message: german
        ? "Sprachstatistik: Wörter insgesamt: " +
          analysis.wordCount +
          " · die angeforderte Fehlerzählung ist derzeit nicht verfügbar."
        : "Language statistics: total words: " +
          analysis.wordCount +
          " · the requested error count is currently unavailable.",
    }
  }

  const values = [
    german
      ? "Wörter insgesamt: " + analysis.wordCount
      : "total words: " + analysis.wordCount,
  ]
  if (analysis.spelling) {
    values.push(
      german
        ? "Rechtschreibfehler: " + analysis.spellingErrors
        : "spelling errors: " + analysis.spellingErrors,
      german
        ? "Zeichensetzungsfehler: " + analysis.punctuationErrors
        : "punctuation errors: " + analysis.punctuationErrors,
    )
  }
  if (analysis.syntax) {
    values.push(
      german
        ? "Grammatik-/Satzbaufehler: " + analysis.syntaxErrors
        : "grammar/sentence-structure errors: " + analysis.syntaxErrors,
    )
  }

  return {
    code: "language-analysis",
    message:
      (german
        ? "Sprachstatistik (Fehlerzahlen als Modellschätzung):\n"
        : "Language statistics (error counts are model estimates):\n") +
      values.join(" · "),
    ...(analysis.orthographyCorrection
      ? { orthographyCorrection: analysis.orthographyCorrection }
      : {}),
  }
}

export function feedbackForResult(
  result: EvaluationResult,
  locale = "de-DE",
): LearnerFeedback | null {
  const content = contentFeedbackForResult(result, locale)
  const language = languageFeedback(result.languageAnalysis, locale)
  if (!language) return content
  if (!content) return language
  return {
    ...content,
    message: content.message + " " + language.message,
    ...(language.orthographyCorrection
      ? { orthographyCorrection: language.orthographyCorrection }
      : {}),
  }
}

export function feedbackForError(
  error: unknown,
  locale = "de-DE",
): LearnerFeedback | null {
  if (!(error instanceof EvaluationInputError)) return null

  if (error.code === "answer-too-short") {
    const content: LearnerFeedback = {
      code: "answer-too-short",
      message: isGerman(locale)
        ? error.operator?.tooShortFeedback.de ??
          "Die Antwort ist deutlich zu kurz, um die Aufgabe ausreichend zu bearbeiten."
        : error.operator?.tooShortFeedback.en ??
          "The answer is much too short to address the task adequately.",
    }
    const language = languageFeedback(error.languageAnalysis, locale)
    return language
      ? {
          ...content,
          message: content.message + " " + language.message,
          ...(language.orthographyCorrection
            ? { orthographyCorrection: language.orthographyCorrection }
            : {}),
        }
      : content
  }

  return null
}
