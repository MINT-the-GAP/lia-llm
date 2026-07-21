import type { OperatorRubric } from "./types.ts"

const RUBRICS: readonly OperatorRubric[] = [
  {
    id: "erklaeren",
    label: "Erklärung",
    aliases: ["erklaeren", "erklären", "erklaere", "erkläre"],
    minAnswerCharacters: 24,
    requirements: [
      "Die für die Frage wesentlichen fachlichen Aussagen sind enthalten.",
      "Der gefragte Zusammenhang wird nachvollziehbar hergestellt; Ursache und Wirkung werden nicht vertauscht.",
      "Die Antwort geht über ein bloßes Nennen oder Behaupten des Ergebnisses hinaus.",
    ],
    operatorFeedback: {
      de: "Die Antwort entspricht noch nicht den Kriterien einer Erklärung.",
      en: "The answer does not yet meet the requirements of an explanation.",
    },
    tooShortFeedback: {
      de: "Die Antwort ist deutlich zu kurz, um etwas zu erklären.",
      en: "The answer is much too short to provide an explanation.",
    },
  },
]

function normalizeAlias(value: string): string {
  return value.trim().toLocaleLowerCase("de-DE").replace(/\s+/gu, " ")
}

const RUBRIC_BY_ALIAS = new Map<string, OperatorRubric>()
for (const rubric of RUBRICS) {
  RUBRIC_BY_ALIAS.set(normalizeAlias(rubric.id), rubric)
  for (const alias of rubric.aliases) {
    RUBRIC_BY_ALIAS.set(normalizeAlias(alias), rubric)
  }
}

export function resolveOperatorRubric(
  value: string | null | undefined,
): OperatorRubric | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined
  }
  const rubric = RUBRIC_BY_ALIAS.get(normalizeAlias(value))
  if (rubric) return rubric

  throw new Error(
    `Der Aufgabenoperator "${value}" wird noch nicht unterstützt. Unterstützt: ${RUBRICS.map((entry) => entry.id).join(", ")}.`,
  )
}

export function supportedOperatorRubrics(): readonly OperatorRubric[] {
  return RUBRICS
}
