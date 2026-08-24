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
  | "operator-check-unavailable"
  | "language-analysis"
  | "language-analysis-unavailable"

export type RuntimeDevice = "wasm" | "webgpu"
export type RuntimeDType = "q8" | "fp32" | "fp16" | "q4" | "q4f16"

export type OperatorRequirementPolicy =
  | "not-required"
  | "required"
  | "task-dependent"

export interface OperatorResponseContract {
  /** The kind of response the learner is expected to produce. */
  product: string
  /** Required rhetorical or logical ordering; the task wording controls its concrete scope. */
  organization: readonly string[]
  evidencePolicy: OperatorRequirementPolicy
  procedurePolicy: OperatorRequirementPolicy
  /** Boundaries that must not be invented from the operator verb alone. */
  constraints: readonly string[]
}

export interface OperatorCriterion {
  id: string
  label: string
  requirement: string
  priority: number
  required: boolean
  feedback: {
    de: string
    en: string
  }
}

export interface OperatorRubric {
  id: string
  label: string
  aliases: readonly string[]
  minAnswerCharacters: number
  responseContract: OperatorResponseContract
  criteria: readonly OperatorCriterion[]
  /** Flat compatibility view used by older API consumers and prompt integrations. */
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
  /** Additional complete reference answers; any one may satisfy the task. */
  referenceVariants?: string[]
  operator?: string
  assessmentEngine?: AssessmentEngine
  criteria?: string | CriterionInput[]
  criterionThreshold?: number
  contradictionThreshold?: number
  passThreshold?: number
  uncertaintyMargin?: number
  contrastiveMargin?: number
  minAnswerCharacters?: number
  languageAnalysis?: LanguageAnalysisOptions
}

export interface LanguageAnalysisOptions {
  /** Count spelling and punctuation errors separately. */
  spelling?: boolean
  /** Count sentence-structure errors. */
  syntax?: boolean
}

export interface NormalizedLanguageAnalysisOptions {
  spelling: boolean
  syntax: boolean
}

export type OrthographyCorrectionKind = "spelling" | "punctuation"

export interface OrthographyCorrectionEdit {
  kind: OrthographyCorrectionKind
  /** Zero-based line in the normalized original answer. */
  line: number
  /** Zero-based Unicode-codepoint column in that original line. */
  column: number
  source: string
  replacement: string
}

export interface OrthographyCorrectionPart {
  text: string
  changed: boolean
  kind?: OrthographyCorrectionKind
  /** Original text removed at this position; never rendered as markup. */
  removedText?: string
}

export interface OrthographyCorrection {
  parts: OrthographyCorrectionPart[]
}

export interface LanguageAnalysisResult
  extends NormalizedLanguageAnalysisOptions {
  status: "completed" | "unavailable"
  /** Deterministic Unicode-aware word count. */
  wordCount: number
  spellingErrors?: number
  punctuationErrors?: number
  syntaxErrors?: number
  /** Validated spelling and punctuation preview; never includes syntax edits. */
  orthographyCorrection?: OrthographyCorrection
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
  /** Maximum shared wall-clock budget currently available if adaptive Thinking is needed. */
  thinkingTimeLimitMs?: number
  /** Remaining shared wall-clock budget while an adaptive Thinking pass is active. */
  thinkingTimeRemainingMs?: number
}

export interface ActivityDisplayOptions {
  /** Visible phase message; falls back to the built-in message for the phase. */
  message?: string
  /** Shows the maximum additional Thinking budget before a pass starts. */
  thinkingTimeLimitMs?: number
  /** Starts a visual countdown for an active adaptive Thinking pass. */
  thinkingTimeRemainingMs?: number
}

export interface EvaluationOptions {
  signal?: AbortSignal
  /** Maximum wall-clock time for an adaptive Qwen thinking pass. Zero disables it. */
  maxThinkingTimeMs?: number
  /** Maximum generated tokens shared by thinking content and the final JSON result. */
  maxThinkingTokens?: number
  onProgress?(progress: EvaluationProgress): void
}

export interface NormalizedEvaluationRequest {
  question: string
  answer: string
  reference: string
  /** Complete normalized reference answers in author order, including `reference`. */
  references: string[]
  operator?: OperatorRubric
  mode: EvaluationMode
  criteria: Criterion[]
  contradictionThreshold: number
  passThreshold: number
  uncertaintyMargin: number
  contrastiveMargin: number
  minAnswerCharacters: number
  languageAnalysis?: NormalizedLanguageAnalysisOptions
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
  /** Missing operator criterion reported by the quality model after runtime validation. */
  operatorCriterionId?: string
  /** Zero-based complete reference-answer variant selected for this result. */
  selectedReferenceIndex?: number
}

export type EvaluationDiagnosticCode =
  | Exclude<QualityFeedbackCode, "none">
  | "operator-check-unavailable"

export interface EvaluationDiagnostic {
  code: EvaluationDiagnosticCode
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
  /** Zero-based authored reference variant best matching the answer; defaults to 0. */
  selectedReferenceIndex?: number
  operator?: OperatorRubric
  diagnostic?: EvaluationDiagnostic
  /** Optional advisory language statistics; never changes `passed`. */
  languageAnalysis?: LanguageAnalysisResult
  durationMs: number
  model: {
    id: string
    revision: string
    device: RuntimeDevice | "none"
    dtype: RuntimeDType | "none"
    task:
      | "natural-language-inference"
      | "generative-assessment"
      | "deterministic-guard"
  }
  notice: string
}

export interface LearnerFeedback {
  code: LearnerFeedbackCode
  message: string
  orthographyCorrection?: OrthographyCorrection
}

export interface FeedbackLanguageCheckResult {
  message: string
  completed: boolean
  orthographyCorrection?: OrthographyCorrection
}

export interface FeedbackLanguageCheckRequest {
  runId: string
  kind: "orthography" | "syntax"
  run(signal: AbortSignal): Promise<FeedbackLanguageCheckResult>
}

export interface FeedbackDisplayOptions {
  orthographyCorrection?: OrthographyCorrection
  languageCheck?: FeedbackLanguageCheckRequest
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

export type DebugFindingSeverity = "info" | "warning" | "error"
export type DebugFindingConfidence = "high" | "medium" | "low"
export type DebugReportTrigger =
  | "manual"
  | "load-error"
  | "post-ready-cache-check"

export interface DebugFinding {
  code: string
  severity: DebugFindingSeverity
  confidence: DebugFindingConfidence
  title: string
  analysis: string
  action?: string
  evidence: string[]
}

export interface DebugTraceEvent {
  sequence: number
  elapsedMs: number
  /** Identifies the concrete load attempt this event belongs to. */
  runId?: string
  kind:
    | "load-start"
    | "policy"
    | "persistence"
    | "cache"
    | "fetch-start"
    | "fetch-response"
    | "fetch-attempt-error"
    | "fetch-activity"
    | "fetch-retry"
    | "language-analysis"
    | "failure"
    | "status"
  engine?: AssessmentEngine
  stage?: string
  artifact?: string
  host?: string
  method?: string
  transport?: "direct" | "range" | "unknown"
  attempt?: number
  httpStatus?: number
  loaded?: number
  expected?: number
  durationMs?: number
  outcome?: string
  errorName?: string
  message?: string
  details?: Record<string, string | number | boolean | null>
}

export interface DebugEnvironment {
  origin: string | null
  browser: string
  platform: string
  mobile: boolean | null
  online: boolean | null
  saveData: boolean | null
  connectionType: string | null
  secureContext: boolean
  topLevel: boolean | null
  cacheStorage: boolean
  storageManager: boolean
  serviceWorkerControlled: boolean
  webAssembly: boolean
  webGpu: boolean
  crossOriginIsolated: boolean
}

export interface DebugStorageSummary {
  persisted: boolean | null
  usageMiB: number | null
  quotaMiB: number | null
  remainingMiB: number | null
  usagePercent: number | null
  cache: ModelCacheInfo | null
  error?: string
}

export interface LiaLLMDebugReport {
  schemaVersion: 1
  libraryVersion: string
  generatedAt: string
  runId: string
  trigger: DebugReportTrigger
  outcome: "ready" | "failed" | "cache-incomplete" | "unknown"
  summary: string
  primaryCause: string
  runtime: RuntimeStatus | null
  environment: DebugEnvironment
  storage: DebugStorageSummary
  findings: DebugFinding[]
  events: DebugTraceEvent[]
  privacy: {
    localOnly: true
    studentContentLogged: false
    responseBodiesLogged: false
    stacksLogged: false
    urlPolicy: "origin-host-and-artifact-only"
  }
}

export interface DebugReportOptions {
  print?: boolean
}

export interface LiaLLMApi {
  readonly version: string
  configure(config: Partial<RuntimeConfig>): RuntimeStatus
  preload(): Promise<RuntimeStatus>
  evaluate(
    request: EvaluationRequest,
    options?: EvaluationOptions,
  ): Promise<EvaluationResult>
  /** Runs only the optional language analysis; it never reassesses content. */
  evaluateLanguage(
    request: EvaluationRequest,
    options?: EvaluationOptions,
  ): Promise<LanguageAnalysisResult | undefined>
  getStatus(): RuntimeStatus
  getCacheInfo(): Promise<ModelCacheInfo>
  debugReport(options?: DebugReportOptions): Promise<LiaLLMDebugReport>
  clearCache(): Promise<number>
  parseMacroOptions(source: string): import("./macro-options.ts").LLMQuizMacroOptions
  parseReferenceVariants(source: string): string[]
  parseCriteria(source: string | CriterionInput[] | undefined): CriterionInput[] | undefined
  formatResult(
    result: EvaluationResult,
    locale?: string,
    options?: ResultFormatOptions,
  ): string
  feedbackForResult(result: EvaluationResult, locale?: string): LearnerFeedback | null
  feedbackForError(error: unknown, locale?: string): LearnerFeedback | null
  showFeedback(
    id: string,
    message: string,
    options?: FeedbackDisplayOptions,
  ): void
  showActivity(
    id: string,
    runId: string,
    phase: EvaluationProgressPhase | "",
    options?: ActivityDisplayOptions,
  ): void
  showSolution(id: string, text: string): void
  setSolutionVariant(id: string, runId: string, index?: number): void
  getSolutionVariant(id: string): number | undefined
  clearSolutionVariant(id: string, runId: string): void
}
