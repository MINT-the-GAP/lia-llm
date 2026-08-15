import { resolveOperatorRubric } from "./operator-rubrics.ts"

export interface LLMQuizMacroOptions {
  passThreshold: number
  solution: boolean
  feedback: boolean
  operator: string | null
  rechtschreibung: boolean
  satzbau: boolean
}

const DEFAULT_OPTIONS: LLMQuizMacroOptions = {
  passThreshold: 0.66,
  solution: true,
  feedback: false,
  operator: null,
  rechtschreibung: false,
  satzbau: false,
}

const DECIMAL_PATTERN = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u

function parsePassThreshold(value: string): number {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error("Die Bestehensgrenze muss eine Dezimalzahl zwischen 0 und 1 sein.")
  }

  const threshold = Number(value)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Die Bestehensgrenze muss zwischen 0 und 1 liegen.")
  }
  return threshold
}

function parseBooleanOption(
  name: "solution" | "feedback" | "rechtschreibung" | "satzbau",
  value: string,
): boolean {
  switch (value.toLowerCase()) {
    case "1":
    case "true":
      return true
    case "0":
    case "false":
      return false
    default:
      throw new Error(
        `Die Option ${name} erwartet 0, 1, true oder false; erhalten wurde "${value}".`,
      )
  }
}

function parseOperatorOption(value: string): string {
  const rubric = resolveOperatorRubric(value)
  if (!rubric) throw new Error("Die Option operator darf nicht leer sein.")
  return rubric.id
}

export function parseMacroOptions(source: string): LLMQuizMacroOptions {
  const parts = source.split(";").map((part) => part.trim())
  const thresholdSource = parts.shift()

  if (!thresholdSource) {
    throw new Error("Die Bestehensgrenze fehlt.")
  }
  if (parts.some((part) => part.length === 0)) {
    throw new Error("Leere Makrooptionen sind nicht zulässig.")
  }

  const options: LLMQuizMacroOptions = {
    ...DEFAULT_OPTIONS,
    passThreshold: parsePassThreshold(thresholdSource),
  }
  if (parts.length === 0) return options

  const named = parts.map((part) => part.includes("="))
  if (named.some(Boolean) && !named.every(Boolean)) {
    throw new Error("Benannte und positionale Makrooptionen dürfen nicht gemischt werden.")
  }

  if (!named[0]) {
    if (parts.length > 3) {
      throw new Error(
        "Die Kurzform erlaubt nur solution, feedback und operator nach der Bestehensgrenze.",
      )
    }
    options.solution = parseBooleanOption("solution", parts[0]!)
    if (parts[1] !== undefined) {
      options.feedback = parseBooleanOption("feedback", parts[1])
    }
    if (parts[2] !== undefined) {
      options.operator = parseOperatorOption(parts[2])
    }
    return options
  }

  const seen = new Set<string>()
  for (const part of parts) {
    const match =
      /^(solution|feedback|operator|rechtschreibung|satzbau)\s*=\s*(\S+)$/iu.exec(
        part,
      )
    if (!match) {
      throw new Error(`Unbekannte oder ungültige Makrooption: "${part}".`)
    }

    const name = match[1]!.toLowerCase() as
      | "solution"
      | "feedback"
      | "operator"
      | "rechtschreibung"
      | "satzbau"
    if (seen.has(name)) {
      throw new Error(`Die Makrooption ${name} wurde mehrfach angegeben.`)
    }
    seen.add(name)
    if (name === "operator") {
      options.operator = parseOperatorOption(match[2]!)
    } else {
      options[name] = parseBooleanOption(name, match[2]!)
    }
  }

  if ((options.rechtschreibung || options.satzbau) && !options.feedback) {
    throw new Error(
      "Rechtschreibung oder Satzbau benötigen feedback=1, damit die Sprachstatistik angezeigt wird.",
    )
  }

  return options
}
