import type {
  EvaluationResult,
  LanguageAnalysisResult,
  LearnerFeedback,
  OperatorRubric,
} from "./types.ts"
import { isFatalQualityEngineError } from "./quality-runtime-errors.ts"

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

const taskActions = [
  {
    id: "begruenden",
    startsWith: /^(?:begründe|begruende|justify)\b/iu,
    de: "Stütze deine Schlussfolgerung mit einem fachlichen Grund.",
    en: "Support your conclusion with a reason.",
  },
  {
    id: "erklaeren",
    startsWith: /^(?:erkläre|erklaere|warum|weshalb|wieso|explain|why)\b/iu,
    de: "Erkläre, wie die gefragten Punkte zusammenhängen.",
    en: "Explain how the requested points are connected.",
  },
  {
    id: "erlaeutern",
    startsWith: /^(?:erläutere|erlaeutere|elaborate)\b/iu,
    de: "Führe den gefragten Zusammenhang genauer aus.",
    en: "Develop the requested connection in more detail.",
  },
  {
    id: "beschreiben",
    startsWith: /^(?:beschreibe|describe)\b/iu,
    de: "Beschreibe die gefragten Merkmale oder Schritte genauer.",
    en: "Describe the requested features or steps in more detail.",
  },
  {
    id: "vergleichen",
    startsWith: /^(?:vergleiche|compare)\b/iu,
    de: "Stelle beide Seiten anhand desselben Merkmals gegenüber.",
    en: "Compare both sides using the same feature.",
  },
  {
    id: "beurteilen",
    startsWith: /^(?:beurteile|judge|evaluate)\b/iu,
    de: "Begründe dein Urteil anhand eines passenden Kriteriums.",
    en: "Support your judgement using a relevant criterion.",
  },
]

function taskParts(question: string): string[] {
  return question.trim().split(/(?<=[.!?])\s+|[\r\n\u2028\u2029]+/u).map((part) => part.trim())
}

function taskInstruction(question: string, german: boolean, operator?: string): string {
  const parts = taskParts(question)
  const actions = taskActions.filter((action) =>
    operator ? action.id === operator : parts.some((part) => action.startsWith.test(part)),
  )
  if (actions.length === 1) {
    const action = actions[0]!
    if (german && action.id === "begruenden" && /\btextstellen?\b/iu.test(question)) {
      return "Stütze deine Schlussfolgerung mit einer passenden Textstelle."
    }
    return german ? action.de : action.en
  }
  return german
    ? "Lies den Arbeitsauftrag noch einmal und ergänze einen konkreten Aspekt."
    : "Read the task again and add a specific point."
}

const commonTaskWords = new Set([
  "about", "according", "could", "their", "there", "these", "those", "which", "would",
  "alles", "anhand", "aufgabe", "außerdem", "beide", "beiden", "dabei", "dadurch", "damit",
  "deine", "denen", "deren", "diese", "diesem", "diesen", "dieser", "dieses", "einem",
  "einen", "einer", "ihren", "ihrer", "indem", "können", "sowie", "unter", "warum",
  "welche", "welchem", "welchen", "welcher", "welches", "werden", "weshalb",
])

function taskWords(text: string): string[] {
  return [...new Set(text.normalize("NFC").toLowerCase().match(/\p{L}{5,}/gu) ?? [])]
    .filter((word) => !commonTaskWords.has(word) &&
      !taskActions.some((action) => action.startsWith.test(word)))
}

function relevantTaskPart(
  question: string,
  criteria: EvaluationResult["criteria"],
): string | undefined {
  // Avoid quoting hidden or formatted fragments. Only authored task text may be shown.
  const plainTask = /^[\p{L}\p{M}\p{N}\s.,?!:;’'–—-]+$/u
  if (!plainTask.test(question.replace(/\$[^$<>\r\n]*\$/gu, " "))) return undefined
  const parts = taskParts(question)
  if (parts.length < 2) return undefined
  const prompts = parts.filter((part) =>
    part.endsWith("?") ||
    /^(?:gehe\s+(?:darauf|auf\b)|gib\s+an|nenne|address|name|list)\b/iu.test(part) ||
    taskActions.some((action) => action.startsWith.test(part)),
  ).map((part) => ({ text: part.replace(/\s+/gu, " "), words: taskWords(part) }))

  for (const criterion of criteria) {
    const terms = taskWords(criterion.supportEvidence.hypothesis)
    const matches = prompts.filter(({ words }) =>
      words.filter((term) => terms.includes(term)).length >= 2,
    )
    if (matches.length !== 1) continue
    const target = matches[0]!.text
    if (target.length <= 140 && plainTask.test(target)) return target
  }
  return undefined
}

function criteriaProgress(result: EvaluationResult, german: boolean): string {
  if (result.mode !== "criteria") return ""
  const met = result.criteria.filter((criterion) => criterion.status === "met").length
  const open = result.criteria.filter((criterion) => criterion.status === "uncertain").length
  if (met === 0) {
    if (open === 0) return ""
    return german
      ? open + (open === 1 ? " Kriterium ist noch offen." : " Kriterien sind noch offen.")
      : open + (open === 1 ? " criterion still open." : " criteria still open.")
  }
  const confirmed = german
    ? met + " von " + result.criteria.length + " Kriterien erfüllt"
    : met + " of " + result.criteria.length + " criteria met"
  if (open === 0) return confirmed + "."
  return confirmed + ", " + open + (german ? " noch offen." : " still open.")
}

function shortAnswerMessage(question: string, german: boolean, operator?: OperatorRubric): string {
  const short = german
    ? operator?.tooShortFeedback.de ?? "Die Antwort ist zu kurz."
    : operator?.tooShortFeedback.en ?? "The answer is too short."
  return short + " " + taskInstruction(question, german, operator?.id)
}

function taskFeedback(
  feedback: LearnerFeedback,
  result: EvaluationResult,
  question: string,
  german: boolean,
): LearnerFeedback {
  if (feedback.code === "quality-check-unavailable" || feedback.code === "operator-check-unavailable") {
    return feedback
  }

  const progress = criteriaProgress(result, german)
  if (result.status === "uncertain") {
    const message = german
      ? "Die Prüfung konnte deine Antwort noch nicht sicher bewerten."
      : "The check could not assess your answer with confidence yet."
    return { code: "unclear", message: [message, progress].filter(Boolean).join(" ") }
  }
  if (feedback.code === "answer-too-short") {
    return { ...feedback, message: shortAnswerMessage(question, german, result.operator) }
  }
  if (result.passed || feedback.code === "off-topic") return feedback

  let next = feedback.message
  if (feedback.code === "content-error" || feedback.code === "incomplete") {
    const contradiction = feedback.code === "content-error"
    const target = result.mode === "criteria" ? relevantTaskPart(
      question,
      result.criteria.filter((criterion) => criterion.status === (contradiction ? "contradicted" : "missed")),
    ) : undefined
    if (contradiction) {
      next = german
        ? "Überprüfe deine Aussage zum gefragten Zusammenhang."
        : "Check your claim about the relationship asked about in the task."
      if (target) {
        next = german
          ? "Überprüfe deine Aussage zu dieser Teilaufgabe. „" + target + "“"
          : "Check your claim for this part of the task. “" + target + "”"
      }
    } else {
      next = target
        ? (german ? "Beantworte auch diesen Teil der Aufgabe. „" + target + "“" : "Also address this part of the task. “" + target + "”")
        : taskInstruction(question, german, result.operator?.id)
    }
  }
  return { ...feedback, message: [progress, next].filter(Boolean).join("\n") }
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

  if (diagnostic?.code === "quality-check-unavailable") {
    return {
      code: "quality-check-unavailable",
      message: german
        ? "Die ausdrücklich angeforderte Qualitätsprüfung war gerade nicht verfügbar. Das Kompaktmodell konnte die Einzelkriterien nicht zuverlässig abschließend bewerten. Versuche die Prüfung später erneut."
        : "The explicitly requested quality assessment was unavailable. The compact model could not reliably reach a final judgement on the individual criteria. Try the assessment again later.",
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
    (result.status !== "passed" &&
      result.criteria.some(
        (criterion) =>
          criterion.judgeDecision === "fail_off_topic" &&
          criterion.status === "missed",
      ))
  ) {
    return {
      code: "off-topic",
      message: german
        ? "Die Antwort geht noch nicht auf die gestellte Frage ein."
        : "The answer does not address the question yet.",
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
  question?: string,
): LearnerFeedback | null {
  const base = contentFeedbackForResult(result, locale)
  const content = base && question !== undefined
    ? taskFeedback(base, result, question, isGerman(locale))
    : base
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
  question?: string,
): LearnerFeedback | null {
  if (isFatalQualityEngineError(error)) {
    return {
      code: "runtime-error",
      message: isGerman(locale)
        ? "Die lokale Modellprüfung wurde wegen eines technischen Laufzeitfehlers beendet. Lade die Seite neu und versuche es erneut. Tritt der Fehler wieder auf, starte den Browser neu."
        : "The local model assessment stopped because of a technical runtime error. Reload the page and try again. If the error recurs, restart the browser.",
    }
  }

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
    if (question !== undefined) content.message = shortAnswerMessage(question, isGerman(locale), error.operator)
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
