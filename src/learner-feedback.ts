import type {
  EvaluationResult,
  LearnerFeedback,
  OperatorRubric,
} from "./types.ts"

export type EvaluationInputErrorCode = "answer-too-short"

export class EvaluationInputError extends Error {
  readonly code: EvaluationInputErrorCode
  readonly actualCharacters: number
  readonly minimumCharacters: number
  readonly operator: OperatorRubric | undefined

  constructor(
    code: EvaluationInputErrorCode,
    message: string,
    actualCharacters: number,
    minimumCharacters: number,
    operator?: OperatorRubric,
  ) {
    super(message)
    this.name = "EvaluationInputError"
    this.code = code
    this.actualCharacters = actualCharacters
    this.minimumCharacters = minimumCharacters
    this.operator = operator
  }
}

function isGerman(locale: string): boolean {
  return locale.toLowerCase().startsWith("de")
}

export function feedbackForResult(
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

  if (diagnostic?.code === "operator-not-met") {
    return {
      code: "operator-not-met",
      message: german
        ? result.operator?.operatorFeedback.de ??
          "Die Antwort erfüllt die Anforderungen des Aufgabenoperators noch nicht."
        : result.operator?.operatorFeedback.en ??
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
      ? "Die Antwort erklärt den gefragten Zusammenhang noch nicht vollständig."
      : "The answer does not yet explain the requested relationship completely.",
  }
}

export function feedbackForError(
  error: unknown,
  locale = "de-DE",
): LearnerFeedback | null {
  if (!(error instanceof EvaluationInputError)) return null

  if (error.code === "answer-too-short") {
    return {
      code: "answer-too-short",
      message: isGerman(locale)
        ? error.operator?.tooShortFeedback.de ??
          "Die Antwort ist deutlich zu kurz, um die Aufgabe ausreichend zu bearbeiten."
        : error.operator?.tooShortFeedback.en ??
          "The answer is much too short to address the task adequately.",
    }
  }

  return null
}
