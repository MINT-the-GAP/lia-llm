import { resolveOperatorRubric } from "./operator-rubrics.ts"
import type { AssessmentEngine } from "./types.ts"

import {
  THINKING_TIME_CHOICES_SECONDS,
  THINKING_TOKEN_PRESETS,
  type ThinkingTokenPreset,
} from './thinking-config.ts'

export interface LLMQuizMacroOptions {
  passThreshold: number
  solution: boolean
  feedback: boolean
  operator: string | null
  rechtschreibung: boolean
  satzbau: boolean
  maxThinkingTimeMs?: number
  maxThinkingTokens?: number
  assessmentEngine?: AssessmentEngine
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

function parseThinkingTimeOption(value: string): number {
  const match = /^(\d+)s$/iu.exec(value)
  if (!match) {
    throw new Error(
      'Die Option maxthinkingtime erwartet 0s, 5s, 10s, 15s, 20s oder 30s.',
    )
  }
  const seconds = Number(match[1])
  if (
    !THINKING_TIME_CHOICES_SECONDS.includes(
      seconds as (typeof THINKING_TIME_CHOICES_SECONDS)[number],
    )
  ) {
    throw new Error(
      'Die Option maxthinkingtime erlaubt nur 0s, 5s, 10s, 15s, 20s oder 30s.',
    )
  }
  return seconds * 1_000
}

function parseThinkingTokensOption(value: string): number {
  const preset = value.toLowerCase() as ThinkingTokenPreset
  const tokens = THINKING_TOKEN_PRESETS[preset]
  if (tokens === undefined) {
    throw new Error(
      'Die Option maxthinkingtokens erwartet low, medium, high, ultra oder extreme.',
    )
  }
  return tokens
}

function parseAssessmentEngineOption(value: string): AssessmentEngine {
  const engine = value.toLowerCase()
  if (engine !== "compact" && engine !== "quality") {
    throw new Error(
      'Die Option assessmentengine erwartet compact oder quality.',
    )
  }
  return engine
}

function explicitlyEnablesThinking(options: LLMQuizMacroOptions): boolean {
  if (options.maxThinkingTimeMs !== undefined) {
    return options.maxThinkingTimeMs > 0
  }
  return options.maxThinkingTokens !== undefined
}

function validateEngineCompatibility(options: LLMQuizMacroOptions): void {
  if (options.assessmentEngine !== "compact") return

  const incompatible: string[] = []
  if (options.operator) incompatible.push("operator")
  if (explicitlyEnablesThinking(options)) {
    incompatible.push("aktivem Thinking")
  }
  if (incompatible.length === 0) return

  throw new Error(
    `assessmentengine=compact ist nicht mit ${incompatible.join(
      ", ",
    )} kombinierbar. Verwende assessmentengine=quality.`,
  )
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
    validateEngineCompatibility(options)
    return options
  }

  const seen = new Set<string>()
  for (const part of parts) {
    const match =
      /^(solution|feedback|operator|rechtschreibung|satzbau|maxthinkingtime|maxthinkingtokens|assessmentengine)\s*=\s*(\S+)$/iu.exec(
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
      | "maxthinkingtime"
      | "maxthinkingtokens"
      | "assessmentengine"
    if (seen.has(name)) {
      throw new Error(`Die Makrooption ${name} wurde mehrfach angegeben.`)
    }
    seen.add(name)
    if (name === "operator") {
      options.operator = parseOperatorOption(match[2]!)
    } else if (name === "maxthinkingtime") {
      options.maxThinkingTimeMs = parseThinkingTimeOption(match[2]!)
    } else if (name === "maxthinkingtokens") {
      options.maxThinkingTokens = parseThinkingTokensOption(match[2]!)
    } else if (name === "assessmentengine") {
      options.assessmentEngine = parseAssessmentEngineOption(match[2]!)
    } else {
      options[name] = parseBooleanOption(name, match[2]!)
    }
  }

  if ((options.rechtschreibung || options.satzbau) && !options.feedback) {
    throw new Error(
      "Rechtschreibung oder Satzbau benötigen feedback=1, damit die Sprachstatistik angezeigt wird.",
    )
  }

  validateEngineCompatibility(options)

  return options
}
