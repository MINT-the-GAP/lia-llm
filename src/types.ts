export type AssessmentStatus = "passed" | "uncertain" | "failed"
export type CriterionStatus = "met" | "uncertain" | "missed" | "contradicted"
export type EvidenceKind = "entailment" | "contradiction"
export type EvaluationMode = "holistic" | "criteria"
export type RuntimePhase = "idle" | "loading" | "ready" | "error"

export type RuntimeDevice = "wasm" | "webgpu"
export type RuntimeDType = "q8" | "fp32" | "fp16" | "q4" | "q4f16"

export interface CriterionInput {
  id?: string
  label?: string
  text: string
  weight?: number
  threshold?: number
  contradictionThreshold?: number
  required?: boolean
  acceptedVariants?: string[]
  misconceptions?: string[]
  feedback?: string
}

export interface Criterion extends CriterionInput {
  id: string
  label: string
  weight: number
  threshold: number
  contradictionThreshold: number
  required: boolean
  acceptedVariants: string[]
  misconceptions: string[]
}

export interface EvaluationRequest {
  question: string
  answer: string
  reference: string
  criteria?: string | CriterionInput[]
  criterionThreshold?: number
  contradictionThreshold?: number
  passThreshold?: number
  uncertaintyMargin?: number
  contrastiveMargin?: number
  minAnswerCharacters?: number
}

export interface NormalizedEvaluationRequest {
  question: string
  answer: string
  reference: string
  mode: EvaluationMode
  criteria: Criterion[]
  contradictionThreshold: number
  passThreshold: number
  uncertaintyMargin: number
  contrastiveMargin: number
  minAnswerCharacters: number
}

export interface NliScores {
  entailment: number
  neutral: number
  contradiction: number
}

export interface NliEvidence extends NliScores {
  text: string
  hypothesis: string
}

export interface CriterionResult extends NliScores {
  id: string
  label: string
  status: CriterionStatus
  misconceptionEntailment: number | null
  supportEvidence: NliEvidence
  contradictionEvidence: NliEvidence
  misconceptionEvidence?: NliEvidence
  evidenceKind: EvidenceKind
  /** @deprecated Use `entailment`. */
  similarity: number
  /** @deprecated Use `misconceptionEntailment`. */
  misconceptionSimilarity: number | null
  weight: number
  required: boolean
  evidence: string
  feedback?: string
}

export interface EvaluationResult {
  status: AssessmentStatus
  passed: boolean
  mode: EvaluationMode
  coverage: number
  potentialCoverage: number
  criteria: CriterionResult[]
  answer: string
  durationMs: number
  model: {
    id: string
    revision: string
    device: RuntimeDevice
    dtype: RuntimeDType
    task: "natural-language-inference"
  }
  notice: string
}

export interface RuntimeConfig {
  modelId: string
  revision: string
  device: RuntimeDevice
  dtype: RuntimeDType
  fallbackToWasm: boolean
  batchSize: number
  /** @deprecated No longer used by the NLI evaluator. */
  maxCachedEmbeddings?: number
}

export interface RuntimeStatus {
  phase: RuntimePhase
  modelId: string
  revision: string
  device: RuntimeDevice
  dtype: RuntimeDType
  error?: string
}

export interface ModelProgress {
  status: string
  progress?: number
  loaded?: number
  total?: number
  file?: string
  message?: string
}

export interface ModelCacheInfo {
  supported: boolean
  cached: boolean
  filesCached: number
  filesTotal: number
  estimatedBytes: number
  error?: string
}

export interface ResultFormatOptions {
  showCriteria?: boolean
}

export interface LiaLLMApi {
  readonly version: string
  configure(config: Partial<RuntimeConfig>): RuntimeStatus
  preload(): Promise<RuntimeStatus>
  evaluate(request: EvaluationRequest): Promise<EvaluationResult>
  getStatus(): RuntimeStatus
  getCacheInfo(): Promise<ModelCacheInfo>
  clearCache(): Promise<number>
  parseCriteria(source: string | CriterionInput[] | undefined): CriterionInput[] | undefined
  formatResult(
    result: EvaluationResult,
    locale?: string,
    options?: ResultFormatOptions,
  ): string
  showFeedback(id: string, html: string): void
}
