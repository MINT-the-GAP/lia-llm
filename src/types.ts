export type AssessmentStatus = "passed" | "uncertain" | "failed"
export type CriterionStatus = "met" | "uncertain" | "missed" | "contradicted"
export type EvidenceKind = "entailment" | "contradiction"
export type EvaluationMode = "holistic" | "criteria"
export type AssessmentEngine = "quality" | "compact"
export interface ModelDownloadConsentDetail {
  id: string
  engine: AssessmentEngine
  modelName: string
  estimatedBytes: number
  handled: boolean
  signal?: AbortSignal
  respond(allow: boolean): void
}
export type QualityDecision =
  | "pass"
  | "fail_contradiction"
  | "fail_incomplete"
  | "fail_off_topic"
  | "uncertain"
export type QualityFeedbackCode =
  | "none"
  | "answer-too-short"
  | "content-error"
  | "incomplete"
  | "off-topic"
  | "unclear"
  | "too-colloquial"
  | "operator-not-met"
export type RuntimePhase = "idle" | "loading" | "ready" | "error"
export type ModelLoadSource = "cache" | "network"
export type LearnerFeedbackCode =
  | "answer-too-short"
  | "contradiction"
  | "uncertain"
  | "incomplete"
  | "off-topic"
  | "colloquial-style"
  | "operator-mismatch"
  | "content-error"
  | "unclear"
  | "too-colloquial"
  | "operator-not-met"

export type RuntimeDevice = "wasm" | "webgpu"
export type RuntimeDType = "q8" | "fp32" | "fp16" | "q4" | "q4f16"

export interface OperatorRubric {
  id: string
  label: string
  aliases: readonly string[]
  minAnswerCharacters: number
  requirements: readonly string[]
  operatorFeedback: {
    de: string
    en: string
  }
  tooShortFeedback: {
    de: string
    en: string
  }
}

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
  operator?: string
  assessmentEngine?: AssessmentEngine
  criteria?: string | CriterionInput[]
  criterionThreshold?: number
  contradictionThreshold?: number
  passThreshold?: number
  uncertaintyMargin?: number
  contrastiveMargin?: number
  minAnswerCharacters?: number
}

export type EvaluationProgressPhase =
  | "selecting-model"
  | "preparing-compact"
  | "evaluating-compact"
  | "preparing-quality"
  | "evaluating-quality"
  | "fallback-compact"

export interface EvaluationProgress {
  phase: EvaluationProgressPhase
  engine: AssessmentEngine
  message: string
}

export interface EvaluationOptions {
  signal?: AbortSignal
  onProgress?(progress: EvaluationProgress): void
}

export interface NormalizedEvaluationRequest {
  question: string
  answer: string
  reference: string
  operator?: OperatorRubric
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
  judgeDecision?: QualityDecision
  judgeFeedbackCode?: QualityFeedbackCode
  judgeConfidence?: number
}

export interface EvaluationDiagnostic {
  code: Exclude<QualityFeedbackCode, "none">
  confidence?: number
  source: "deterministic" | "compact" | "quality"
  severity: "blocking" | "advisory"
}

export interface EvaluationResult {
  status: AssessmentStatus
  passed: boolean
  mode: EvaluationMode
  coverage: number
  potentialCoverage: number
  criteria: CriterionResult[]
  answer: string
  operator?: OperatorRubric
  diagnostic?: EvaluationDiagnostic
  durationMs: number
  model: {
    id: string
    revision: string
    device: RuntimeDevice
    dtype: RuntimeDType
    task: "natural-language-inference" | "generative-assessment"
  }
  notice: string
}

export interface LearnerFeedback {
  code: LearnerFeedbackCode
  message: string
}

export interface RuntimeConfig {
  assessmentEngine: AssessmentEngine
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
  loadSource?: ModelLoadSource
  assessmentEngine: AssessmentEngine
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
  /**
   * True when the complete large model payload is already cached, even if
   * smaller runtime metadata still needs to be prepared.
   */
  downloadCached?: boolean
  filesCached: number
  filesTotal: number
  estimatedBytes: number
  persistent?: boolean
  engines?: Partial<Record<AssessmentEngine, ModelCacheInfo>>
  error?: string
}

export interface ResultFormatOptions {
  showCriteria?: boolean
}

export interface LiaLLMApi {
  readonly version: string
  configure(config: Partial<RuntimeConfig>): RuntimeStatus
  preload(): Promise<RuntimeStatus>
  evaluate(
    request: EvaluationRequest,
    options?: EvaluationOptions,
  ): Promise<EvaluationResult>
  getStatus(): RuntimeStatus
  getCacheInfo(): Promise<ModelCacheInfo>
  clearCache(): Promise<number>
  parseMacroOptions(source: string): import("./macro-options.ts").LLMQuizMacroOptions
  parseCriteria(source: string | CriterionInput[] | undefined): CriterionInput[] | undefined
  formatResult(
    result: EvaluationResult,
    locale?: string,
    options?: ResultFormatOptions,
  ): string
  feedbackForResult(result: EvaluationResult, locale?: string): LearnerFeedback | null
  feedbackForError(error: unknown, locale?: string): LearnerFeedback | null
  showFeedback(id: string, message: string): void
  showActivity(
    id: string,
    runId: string,
    phase: EvaluationProgressPhase | "",
  ): void
  showSolution(id: string, text: string): void
}
