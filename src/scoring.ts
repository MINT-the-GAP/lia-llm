import type {
  AssessmentStatus,
  Criterion,
  CriterionInput,
  CriterionResult,
  CriterionStatus,
  EvaluationMode,
  EvaluationRequest,
  NliEvidence,
  NormalizedEvaluationRequest,
} from "./types.ts"
import { EvaluationInputError } from "./learner-feedback.ts"
import {
  normalizeLanguageAnalysisOptions,
  unavailableLanguageAnalysis,
} from "./language-analysis.ts"
import { resolveOperatorRubric } from "./operator-rubrics.ts"

export const DEFAULT_CRITERION_THRESHOLD = 0.55
export const DEFAULT_CONTRADICTION_THRESHOLD = 0.65
export const DEFAULT_PASS_THRESHOLD = 1
export const DEFAULT_UNCERTAINTY_MARGIN = 0.1
export const DEFAULT_CONTRASTIVE_MARGIN = 0.15
export const DEFAULT_MIN_ANSWER_CHARACTERS = 12
export const LEGACY_MACRO_QUESTION = "LiaScript-Freitextaufgabe"

const MAX_CRITERIA = 16
const MAX_VARIANTS = 8
const MAX_TEXT_CHARACTERS = 8_000
const MAX_CHUNK_CHARACTERS = 700
const MAX_CHUNKS = 24

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => normalizeText(item))
        .filter(Boolean),
    ),
  ].slice(0, MAX_VARIANTS)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim()
}

export function normalizeAnswerText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?|[\u2028\u2029]/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function parseCriteria(
  source: string | CriterionInput[] | undefined,
): CriterionInput[] | undefined {
  if (source === undefined) return undefined
  if (Array.isArray(source)) return source

  const trimmed = source.trim()
  if (!trimmed) return undefined

  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      throw new Error("Die Kriterien müssen ein JSON-Array sein.")
    }

    return parsed.map((item, index) => {
      const record = asRecord(item)
      if (!record || typeof record.text !== "string") {
        throw new Error(`Kriterium ${index + 1} benötigt das Feld "text".`)
      }

      return {
        id: optionalString(record.id),
        label: optionalString(record.label),
        text: record.text,
        weight: finiteNumber(record.weight),
        threshold: finiteNumber(record.threshold),
        contradictionThreshold: finiteNumber(record.contradictionThreshold),
        required: typeof record.required === "boolean" ? record.required : undefined,
        acceptedVariants: stringArray(record.acceptedVariants),
        misconceptions: stringArray(record.misconceptions),
        feedback: optionalString(record.feedback),
      }
    })
  }

  return trimmed
    .split(/\s*\|\|\s*|\r?\n+/gu)
    .map((text) => normalizeText(text))
    .filter(Boolean)
    .map((text) => ({ text }))
}

export function splitReference(reference: string): string[] {
  const normalized = normalizeAnswerText(reference)
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n{2,}/gu)
    .map((paragraph) => normalizeText(paragraph))
    .filter(Boolean)
  const statements = paragraphs.flatMap((paragraph) =>
    paragraph
      .split(/(?<=[.!?;])\s+/gu)
      .map((part) => normalizeText(part))
      .filter((part) => part.length >= 4),
  )

  return statements.length > 0 ? statements : [normalizeText(reference)]
}

function safeId(value: string, index: number): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
  return normalized || `criterion-${index + 1}`
}

function assertUnitInterval(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} muss zwischen 0 und 1 liegen.`)
  }
  return value
}

function normalizeCriterion(
  input: CriterionInput,
  index: number,
  defaultThreshold: number,
  defaultContradictionThreshold: number,
): Criterion {
  const text = normalizeAnswerText(input.text)
  if (!text) throw new Error(`Kriterium ${index + 1} ist leer.`)

  const weight = input.weight ?? 1
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`Kriterium ${index + 1} benötigt ein positives Gewicht.`)
  }

  const threshold = assertUnitInterval(
    `Der Folgerungsschwellwert von Kriterium ${index + 1}`,
    input.threshold ?? defaultThreshold,
  )
  const contradictionThreshold = assertUnitInterval(
    `Der Widerspruchsschwellwert von Kriterium ${index + 1}`,
    input.contradictionThreshold ?? defaultContradictionThreshold,
  )

  const id = safeId(input.id ?? input.label ?? `criterion-${index + 1}`, index)
  return {
    id,
    label: normalizeText(input.label ?? input.id ?? `Kriterium ${index + 1}`),
    text,
    weight,
    threshold,
    contradictionThreshold,
    required: input.required ?? false,
    acceptedVariants: stringArray(input.acceptedVariants),
    misconceptions: stringArray(input.misconceptions),
    feedback: optionalString(input.feedback),
  }
}

export function normalizeRequest(request: EvaluationRequest): NormalizedEvaluationRequest {
  const question = normalizeText(request.question)
  const answer = normalizeAnswerText(request.answer)
  const reference = normalizeAnswerText(request.reference)
  const operator = resolveOperatorRubric(request.operator)
  const languageAnalysis = normalizeLanguageAnalysisOptions(
    request.languageAnalysis,
  )

  if (!question) throw new Error("Die Fragestellung fehlt.")
  if (
    operator &&
    question.toLocaleLowerCase("de-DE") ===
      LEGACY_MACRO_QUESTION.toLocaleLowerCase("de-DE")
  ) {
    throw new Error(
      "Operatoren benötigen den echten Aufgabenwortlaut. Verwende @LLMQuiz.question(...) oder übergib question über die API.",
    )
  }
  if (!reference) throw new Error("Die Musterlösung fehlt.")
  if (answer.length > MAX_TEXT_CHARACTERS) {
    throw new Error(`Die Antwort darf höchstens ${MAX_TEXT_CHARACTERS} Zeichen lang sein.`)
  }

  const minAnswerCharacters = Math.max(
    1,
    Math.floor(request.minAnswerCharacters ?? DEFAULT_MIN_ANSWER_CHARACTERS),
    operator?.minAnswerCharacters ?? 1,
  )
  if (answer.length < minAnswerCharacters) {
    throw new EvaluationInputError(
      "answer-too-short",
      `Die Antwort ist zu kurz (mindestens ${minAnswerCharacters} Zeichen).`,
      answer.length,
      minAnswerCharacters,
      operator,
      languageAnalysis
        ? unavailableLanguageAnalysis(answer, languageAnalysis)
        : undefined,
    )
  }

  const defaultThreshold = assertUnitInterval(
    "criterionThreshold",
    request.criterionThreshold ?? DEFAULT_CRITERION_THRESHOLD,
  )
  const contradictionThreshold = assertUnitInterval(
    "contradictionThreshold",
    request.contradictionThreshold ?? DEFAULT_CONTRADICTION_THRESHOLD,
  )

  const explicitCriteria = parseCriteria(request.criteria)
  const mode: EvaluationMode = explicitCriteria ? "criteria" : "holistic"
  const rawCriteria = explicitCriteria ?? [
    {
      id: "overall-answer",
      label: "Gesamtantwort",
      text: reference,
      required: true,
    },
  ]
  if (rawCriteria.length === 0) throw new Error("Mindestens ein Kriterium wird benötigt.")
  if (rawCriteria.length > MAX_CRITERIA) {
    throw new Error(`Es sind höchstens ${MAX_CRITERIA} Kriterien erlaubt.`)
  }

  const criteria = rawCriteria.map((item, index) =>
    normalizeCriterion(item, index, defaultThreshold, contradictionThreshold),
  )
  const ids = new Set<string>()
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) throw new Error(`Doppelte Kriterien-ID: ${criterion.id}`)
    ids.add(criterion.id)
  }

  return {
    question,
    answer,
    reference,
    operator,
    mode,
    criteria,
    contradictionThreshold,
    passThreshold: assertUnitInterval(
      "passThreshold",
      request.passThreshold ?? DEFAULT_PASS_THRESHOLD,
    ),
    uncertaintyMargin: assertUnitInterval(
      "uncertaintyMargin",
      request.uncertaintyMargin ?? DEFAULT_UNCERTAINTY_MARGIN,
    ),
    contrastiveMargin: assertUnitInterval(
      "contrastiveMargin",
      request.contrastiveMargin ?? DEFAULT_CONTRASTIVE_MARGIN,
    ),
    minAnswerCharacters,
    languageAnalysis,
  }
}

function splitLongChunk(value: string): string[] {
  if (value.length <= MAX_CHUNK_CHARACTERS) return [value]

  const words = value.split(/\s+/u)
  const chunks: string[] = []
  let current = ""
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > MAX_CHUNK_CHARACTERS && current) {
      chunks.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function limitOrderedChunks(chunks: readonly string[]): string[] {
  const unique = [...new Set(chunks.filter(Boolean))]
  if (unique.length <= MAX_CHUNKS) return unique

  return Array.from({ length: MAX_CHUNKS }, (_, index) =>
    unique[
      Math.round((index * (unique.length - 1)) / (MAX_CHUNKS - 1))
    ]!,
  )
}

export function chunkAnswer(answer: string): string[] {
  const normalized = normalizeAnswerText(answer)
  const paragraphs = normalized
    .split(/\n{2,}/gu)
    .map((paragraph) => normalizeText(paragraph))
    .filter(Boolean)
  const paragraphChunks = paragraphs.flatMap(splitLongChunk)
  const sentences = paragraphs.flatMap((paragraph) =>
    paragraph
      .split(/(?<=[.!?;])\s+/gu)
      .flatMap((part) => splitLongChunk(normalizeText(part)))
      .filter((part) => part.length >= 4),
  )

  if (normalized.length > MAX_CHUNK_CHARACTERS) {
    return limitOrderedChunks(splitLongChunk(normalizeText(normalized)))
  }

  return limitOrderedChunks([
    normalizeText(normalized),
    ...paragraphChunks,
    ...sentences,
  ])
}

export function evaluationAnswerContexts(
  answer: string,
  _mode: EvaluationMode,
): string[] {
  const normalized = normalizeAnswerText(answer)
  if (!normalized) return []
  if (normalized.length <= MAX_CHUNK_CHARACTERS) return [normalized]
  return chunkAnswer(normalized)
}

function decisive(
  value: number,
  alternatives: readonly number[],
  threshold: number,
  contrastiveMargin: number,
): boolean {
  return value >= threshold && value - Math.max(...alternatives) >= contrastiveMargin
}

function roundScore(value: number): number {
  return Number(clamp01(value).toFixed(4))
}

function roundEvidence(evidence: NliEvidence): NliEvidence {
  return {
    text: evidence.text,
    hypothesis: evidence.hypothesis,
    entailment: roundScore(evidence.entailment),
    neutral: roundScore(evidence.neutral),
    contradiction: roundScore(evidence.contradiction),
  }
}

export interface CriterionClassificationInput {
  criterion: Criterion
  supportEvidence: NliEvidence
  contradictionEvidence: NliEvidence
  misconceptionEvidence?: NliEvidence
  uncertaintyMargin: number
  contrastiveMargin: number
}

export function classifyCriterion(input: CriterionClassificationInput): CriterionResult {
  const {
    criterion,
    supportEvidence,
    contradictionEvidence,
    misconceptionEvidence,
    uncertaintyMargin,
    contrastiveMargin,
  } = input

  const positiveStrong = decisive(
    supportEvidence.entailment,
    [supportEvidence.neutral, supportEvidence.contradiction],
    criterion.threshold,
    contrastiveMargin,
  )
  const directContradictionStrong = decisive(
    contradictionEvidence.contradiction,
    [contradictionEvidence.entailment, contradictionEvidence.neutral],
    criterion.contradictionThreshold,
    contrastiveMargin,
  )
  const misconceptionStrong =
    misconceptionEvidence !== undefined &&
    decisive(
      misconceptionEvidence.entailment,
      [misconceptionEvidence.neutral, misconceptionEvidence.contradiction],
      criterion.contradictionThreshold,
      contrastiveMargin,
    )
  const negativeStrong = directContradictionStrong || misconceptionStrong

  const directContradiction = contradictionEvidence.contradiction
  const misconceptionEntailment = misconceptionEvidence?.entailment ?? null
  const contradiction = Math.max(directContradiction, misconceptionEntailment ?? 0)
  const negativeEvidence =
    misconceptionEvidence && misconceptionEvidence.entailment > directContradiction
      ? misconceptionEvidence
      : contradictionEvidence

  const positiveNear =
    supportEvidence.entailment >= Math.max(0, criterion.threshold - uncertaintyMargin)
  const negativeNear =
    directContradiction >=
      Math.max(0, criterion.contradictionThreshold - uncertaintyMargin) ||
    (misconceptionEntailment !== null &&
      misconceptionEntailment >=
        Math.max(0, criterion.contradictionThreshold - uncertaintyMargin))

  let status: CriterionStatus
  if (negativeStrong) status = "contradicted"
  else if (positiveStrong) status = "met"
  else if (positiveNear || negativeNear) status = "uncertain"
  else status = "missed"

  const evidenceKind =
    status === "contradicted" ||
    (status === "uncertain" && contradiction >= supportEvidence.entailment)
      ? "contradiction"
      : "entailment"
  const evidence = evidenceKind === "contradiction" ? negativeEvidence : supportEvidence

  return {
    id: criterion.id,
    label: criterion.label,
    status,
    entailment: roundScore(supportEvidence.entailment),
    neutral: roundScore(supportEvidence.neutral),
    contradiction: roundScore(contradiction),
    misconceptionEntailment:
      misconceptionEntailment === null ? null : roundScore(misconceptionEntailment),
    supportEvidence: roundEvidence(supportEvidence),
    contradictionEvidence: roundEvidence(contradictionEvidence),
    misconceptionEvidence: misconceptionEvidence
      ? roundEvidence(misconceptionEvidence)
      : undefined,
    evidenceKind,
    similarity: roundScore(supportEvidence.entailment),
    misconceptionSimilarity:
      misconceptionEntailment === null ? null : roundScore(misconceptionEntailment),
    weight: criterion.weight,
    required: criterion.required,
    evidence: evidence.text,
    feedback: criterion.feedback,
  }
}

export interface AggregatedAssessment {
  status: AssessmentStatus
  passed: boolean
  coverage: number
  potentialCoverage: number
}

export function aggregateCriteria(
  criteria: CriterionResult[],
  passThreshold: number,
): AggregatedAssessment {
  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  if (totalWeight <= 0) throw new Error("Das Gesamtgewicht der Kriterien muss positiv sein.")

  const metWeight = criteria
    .filter((criterion) => criterion.status === "met")
    .reduce((sum, criterion) => sum + criterion.weight, 0)
  const uncertainWeight = criteria
    .filter((criterion) => criterion.status === "uncertain")
    .reduce((sum, criterion) => sum + criterion.weight, 0)

  const coverage = clamp01(metWeight / totalWeight)
  const potentialCoverage = clamp01((metWeight + uncertainWeight) / totalWeight)
  const hasContradiction = criteria.some((criterion) => criterion.status === "contradicted")
  const requiredMissed = criteria.some(
    (criterion) =>
      criterion.required &&
      (criterion.status === "missed" || criterion.status === "contradicted"),
  )
  const requiredUncertain = criteria.some(
    (criterion) => criterion.required && criterion.status === "uncertain",
  )

  let status: AssessmentStatus
  if (
    !hasContradiction &&
    !requiredMissed &&
    !requiredUncertain &&
    coverage + Number.EPSILON >= passThreshold
  ) {
    status = "passed"
  } else if (
    !hasContradiction &&
    !requiredMissed &&
    potentialCoverage + Number.EPSILON >= passThreshold
  ) {
    status = "uncertain"
  } else {
    status = "failed"
  }

  return {
    status,
    passed: status === "passed",
    coverage: Number(coverage.toFixed(4)),
    potentialCoverage: Number(potentialCoverage.toFixed(4)),
  }
}
