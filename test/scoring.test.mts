import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  aggregateCriteria,
  chunkAnswer,
  classifyCriterion,
  evaluationAnswerContexts,
  normalizeAnswerText,
  normalizeRequest,
  parseCriteria,
  splitReference,
} from "../src/scoring.ts"
import { AutomaticEvaluator } from "../src/automatic-evaluator.ts"
import { formatResult } from "../src/format.ts"
import { decideModelDownload } from "../src/download-policy.ts"
import {
  EvaluationInputError,
  feedbackForError,
  feedbackForResult,
} from "../src/learner-feedback.ts"
import {
  fromQuizInputValue,
  isQuizTextareaNavigationKey,
  parseTextareaRows,
  toQuizInputValue,
} from "../src/quiz-textarea.ts"
import { parseMacroOptions } from "../src/macro-options.ts"
import { supportedOperatorRubrics } from "../src/operator-rubrics.ts"
import { progressPercent } from "../src/load-overlay.ts"
import {
  classifyQualityDecision,
  parseQualityJudgeOutput,
  qualityDiagnosticForCriteria,
  QUALITY_SYSTEM_PROMPT,
} from "../src/quality-evaluator.ts"
import type {
  Criterion,
  CriterionResult,
  EvaluationProgressPhase,
  EvaluationRequest,
  EvaluationResult,
  ModelCacheInfo,
  NliEvidence,
  RuntimeStatus,
} from "../src/types.ts"

test("parseCriteria accepts a compact separator syntax", () => {
  assert.deepEqual(parseCriteria("Energieumwandlung || Stoffbilanz\nSauerstoff"), [
    { text: "Energieumwandlung" },
    { text: "Stoffbilanz" },
    { text: "Sauerstoff" },
  ])
})

test("parseCriteria accepts weighted JSON criteria and NLI thresholds", () => {
  const criteria = parseCriteria(
    '[{"id":"density","text":"Eis ist weniger dicht.","weight":2,"required":true,"threshold":0.75,"contradictionThreshold":0.8,"acceptedVariants":["geringere Dichte"]}]',
  )
  assert.equal(criteria?.[0]?.id, "density")
  assert.equal(criteria?.[0]?.weight, 2)
  assert.equal(criteria?.[0]?.required, true)
  assert.equal(criteria?.[0]?.threshold, 0.75)
  assert.equal(criteria?.[0]?.contradictionThreshold, 0.8)
  assert.deepEqual(criteria?.[0]?.acceptedVariants, ["geringere Dichte"])
})

test("normalizeRequest keeps the full reference as one holistic criterion", () => {
  const request = normalizeRequest({
    question: "Warum schwimmt Eis?",
    answer: "Eis besitzt eine geringere Dichte als flüssiges Wasser.",
    reference: "Eis besitzt eine geringere Dichte\n\nEs verdrängt Wasser",
  })
  assert.equal(request.mode, "holistic")
  assert.equal(request.criteria.length, 1)
  assert.equal(
    request.criteria[0]?.text,
    "Eis besitzt eine geringere Dichte\n\nEs verdrängt Wasser",
  )
  assert.equal(request.criteria[0]?.required, true)
  assert.equal(request.criteria[0]?.threshold, 0.55)
  assert.equal(request.criteria[0]?.contradictionThreshold, 0.65)
  assert.equal(request.passThreshold, 1)
})

test("holistic threshold applies to the complete answer-reference comparison", () => {
  const request = normalizeRequest({
    question: "Warum schwimmt Eis?",
    answer: "Eis ist weniger dicht als Wasser und schwimmt deshalb.",
    reference: "Eis ist weniger dicht als Wasser und schwimmt deshalb.",
    criterionThreshold: 0.66,
  })
  assert.equal(request.mode, "holistic")
  assert.equal(request.criteria.length, 1)
  assert.equal(request.criteria[0]?.threshold, 0.66)
  assert.equal(request.passThreshold, 1)
})

test("normalizeRequest only creates multiple criteria when authors provide them", () => {
  const request = normalizeRequest({
    question: "Warum schwimmt Eis?",
    answer: "Eis besitzt eine geringere Dichte als flüssiges Wasser.",
    reference: "Zusammenhängende Musterlösung.",
    criteria: "Dichtevergleich || Ursache des Dichteunterschieds",
  })
  assert.equal(request.mode, "criteria")
  assert.deepEqual(
    request.criteria.map((criterion) => criterion.text),
    ["Dichtevergleich", "Ursache des Dichteunterschieds"],
  )
})

test("normalizeRequest rejects cosine-style negative thresholds", () => {
  assert.throws(
    () =>
      normalizeRequest({
        question: "Warum schwimmt Eis?",
        answer: "Eis besitzt eine geringere Dichte.",
        reference: "Eis ist weniger dicht.",
        criterionThreshold: -0.1,
      }),
    /zwischen 0 und 1/u,
  )
})

test("normalizeRequest reports a structured too-short answer before inference", () => {
  let caught: unknown
  try {
    normalizeRequest({
      question: "Warum schwimmt Eis?",
      answer: "Kurz",
      reference: "Eis ist weniger dicht als flüssiges Wasser.",
      minAnswerCharacters: 12,
    })
  } catch (error) {
    caught = error
  }

  assert.ok(caught instanceof EvaluationInputError)
  assert.equal(caught.code, "answer-too-short")
  assert.equal(caught.actualCharacters, 4)
  assert.equal(caught.minimumCharacters, 12)
  assert.deepEqual(feedbackForError(caught, "de-DE"), {
    code: "answer-too-short",
    message: "Die Antwort ist deutlich zu kurz, um die Aufgabe ausreichend zu bearbeiten.",
  })
  assert.equal(feedbackForError(new Error("Technischer Fehler")), null)
})

test("operator profile sets its own minimum length and feedback", () => {
  let caught: unknown
  try {
    normalizeRequest({
      question: "Erkläre den Zusammenhang.",
      answer: "Zu kurz",
      reference: "Eine vollständige Erklärung des Zusammenhangs.",
      operator: "erklären",
    })
  } catch (error) {
    caught = error
  }

  assert.ok(caught instanceof EvaluationInputError)
  assert.equal(caught.minimumCharacters, 24)
  assert.equal(caught.operator?.id, "erklaeren")
  assert.deepEqual(feedbackForError(caught, "de-DE"), {
    code: "answer-too-short",
    message: "Die Antwort ist deutlich zu kurz, um etwas zu erklären.",
  })
})

test("normalizeAnswerText preserves paragraph breaks", () => {
  assert.equal(
    normalizeAnswerText("  Erster Absatz.\r\n\r\n Zweiter   Absatz.  "),
    "Erster Absatz.\n\nZweiter Absatz.",
  )
})

test("chunkAnswer keeps the whole short answer and useful sentences", () => {
  const chunks = chunkAnswer(
    "Eis hat eine geringere Dichte. Seine Kristallstruktur benötigt mehr Volumen.",
  )
  assert.equal(
    chunks[0],
    "Eis hat eine geringere Dichte. Seine Kristallstruktur benötigt mehr Volumen.",
  )
  assert.ok(chunks.includes("Eis hat eine geringere Dichte."))
  assert.ok(chunks.includes("Seine Kristallstruktur benötigt mehr Volumen."))
})

test("all evaluation modes preserve complete answer context without sentence picking", () => {
  const answer =
    "Eis ist weniger dicht. Deshalb schwimmt es.\n\nBeide Aussagen gehören zusammen."
  assert.deepEqual(evaluationAnswerContexts(answer, "holistic"), [answer])
  assert.deepEqual(evaluationAnswerContexts(answer, "criteria"), [answer])
})

test("soft line wraps stay inside statements while blank lines delimit paragraphs", () => {
  assert.deepEqual(
    splitReference(
      "Beim Gefrieren bildet\ndas Netzwerk eine offene Struktur.\n\nDeshalb nimmt Eis mehr Raum ein.",
    ),
    [
      "Beim Gefrieren bildet das Netzwerk eine offene Struktur.",
      "Deshalb nimmt Eis mehr Raum ein.",
    ],
  )

  const chunks = chunkAnswer(
    "Beim Gefrieren bildet\ndas Netzwerk eine offene Struktur.\n\nDarum ist Eis weniger dicht.",
  )
  assert.ok(chunks.includes("Beim Gefrieren bildet das Netzwerk eine offene Struktur."))
  assert.ok(!chunks.includes("Beim Gefrieren bildet"))
})

const criterion: Criterion = {
  id: "density",
  label: "Dichtevergleich",
  text: "Eis hat eine geringere Dichte als Wasser.",
  weight: 2,
  threshold: 0.7,
  contradictionThreshold: 0.7,
  required: true,
  acceptedVariants: [],
  misconceptions: ["Eis hat eine höhere Dichte als Wasser."],
  feedback: "Vergleiche die Dichten.",
}

test("quality judge accepts strict structured decisions only", () => {
  assert.deepEqual(
    parseQualityJudgeOutput(
      '{"decision":"pass","confidence":0.82,"feedback_code":"none"}',
    ),
    { decision: "pass", confidence: 0.82, feedbackCode: "none" },
  )
  assert.deepEqual(
    parseQualityJudgeOutput(
      '{"decision":"fail_incomplete","confidence":0.82,"feedback_code":"answer-too-short"}',
    ),
    {
      decision: "fail_incomplete",
      confidence: 0.82,
      feedbackCode: "answer-too-short",
    },
  )
  assert.equal(
    parseQualityJudgeOutput(
      '{"decision":"fail_contradiction","confidence":0.9,"feedback_code":"none"}',
    ).feedbackCode,
    "content-error",
  )
  assert.equal(
    parseQualityJudgeOutput(
      '{"decision":"pass","confidence":0.9,"feedback_code":"content-error"}',
    ).feedbackCode,
    "none",
  )
  assert.equal(
    parseQualityJudgeOutput(
      '{"decision":"fail_off_topic","confidence":0.9,"feedback_code":"off-topic"}',
    ).feedbackCode,
    "off-topic",
  )
  assert.equal(
    parseQualityJudgeOutput(
      '{"decision":"uncertain","confidence":0.7,"feedback_code":"unclear"}',
    ).feedbackCode,
    "unclear",
  )
  assert.equal(
    parseQualityJudgeOutput(
      '{"decision":"fail_incomplete","confidence":0.8,"feedback_code":"operator-not-met"}',
    ).feedbackCode,
    "operator-not-met",
  )
  assert.equal(
    parseQualityJudgeOutput('{"decision":"fail_incomplete","confidence":0.8}')
      .feedbackCode,
    "incomplete",
  )
  assert.throws(
    () => parseQualityJudgeOutput('{"decision":"correct","confidence":0.82}'),
    /Entscheidungscode/u,
  )
  assert.throws(
    () => parseQualityJudgeOutput('{"decision":"pass","confidence":1.2}'),
    /Konfidenz/u,
  )
  assert.throws(() => parseQualityJudgeOutput("not-json"), /JSON/u)
})

test("quality judge tolerates WebLLM thinking prefixes and JSON fences", () => {
  assert.deepEqual(
    parseQualityJudgeOutput(
      '\uFEFF \n\t<think>\n\n</think>\n\n{"decision":"pass","confidence":0.91,"feedback_code":"none"}',
    ),
    { decision: "pass", confidence: 0.91, feedbackCode: "none" },
  )
  assert.deepEqual(
    parseQualityJudgeOutput(
      '<think>verdeckte Begründung</think>{"decision":"pass","confidence":0.91,"feedback_code":"too-colloquial"}',
    ),
    {
      decision: "pass",
      confidence: 0.91,
      feedbackCode: "too-colloquial",
    },
  )
  assert.deepEqual(
    parseQualityJudgeOutput(
      '```json\n{"decision":"pass","confidence":0.91,"feedback_code":"none"}\n```',
    ),
    { decision: "pass", confidence: 0.91, feedbackCode: "none" },
  )
})

test("quality judge keeps uncertainty and contradictions out of passing", () => {
  assert.equal(
    classifyQualityDecision(
      { decision: "pass", confidence: 0.8, feedbackCode: "none" },
      criterion,
      0.1,
    ),
    "met",
  )
  assert.equal(
    classifyQualityDecision(
      { decision: "pass", confidence: 0.65, feedbackCode: "none" },
      criterion,
      0.1,
    ),
    "uncertain",
  )
  assert.equal(
    classifyQualityDecision(
      {
        decision: "fail_contradiction",
        confidence: 0.9,
        feedbackCode: "content-error",
      },
      criterion,
      0.1,
    ),
    "contradicted",
  )
  assert.equal(
    classifyQualityDecision(
      {
        decision: "fail_incomplete",
        confidence: 0.9,
        feedbackCode: "incomplete",
      },
      criterion,
      0.1,
    ),
    "missed",
  )
})

test("quality prompt requires contextual synonym and negation handling", () => {
  assert.match(QUALITY_SYSTEM_PROMPT, /Gesamtzusammenhang/u)
  assert.match(QUALITY_SYSTEM_PROMPT, /Synonyme/u)
  assert.match(QUALITY_SYSTEM_PROMPT, /Verneinungen/u)
  assert.match(QUALITY_SYSTEM_PROMPT, /Ursache-Wirkungs-Beziehungen/u)
  assert.match(QUALITY_SYSTEM_PROMPT, /Weltwissen/u)
  assert.match(QUALITY_SYSTEM_PROMPT, /feedback_code/u)
  assert.match(QUALITY_SYSTEM_PROMPT, /Operatorprofil/u)
  assert.match(QUALITY_SYSTEM_PROMPT, /too-colloquial/u)
})

function evidence(
  text: string,
  entailment: number,
  neutral: number,
  contradiction: number,
  hypothesis = criterion.text,
): NliEvidence {
  return { text, hypothesis, entailment, neutral, contradiction }
}

function classify(
  supportEvidence: NliEvidence,
  contradictionEvidence = supportEvidence,
  misconceptionEvidence?: NliEvidence,
): CriterionResult {
  return classifyCriterion({
    criterion,
    supportEvidence,
    contradictionEvidence,
    misconceptionEvidence,
    uncertaintyMargin: 0.1,
    contrastiveMargin: 0.15,
  })
}

test("classifyCriterion marks clear entailment as met", () => {
  const result = classify(
    evidence("Eis ist weniger dicht.", 0.93, 0.05, 0.02),
    evidence("Die Dichte ist geringer.", 0.72, 0.23, 0.05),
  )
  assert.equal(result.status, "met")
  assert.equal(result.entailment, 0.93)
  assert.equal(result.evidenceKind, "entailment")
})

test("classifyCriterion marks a clear negation as contradicted", () => {
  const result = classify(
    evidence("Eis ist nicht weniger dicht.", 0.02, 0.03, 0.95),
  )
  assert.equal(result.status, "contradicted")
  assert.equal(result.evidenceKind, "contradiction")
})

test("classifyCriterion lets a strong contradiction veto a separate correct passage", () => {
  const result = classify(
    evidence("Eis ist weniger dicht.", 0.94, 0.04, 0.02),
    evidence("Eis ist dichter als Wasser.", 0.01, 0.02, 0.97),
  )
  assert.equal(result.status, "contradicted")
})

test("classifyCriterion treats a neutral answer as not supported", () => {
  const result = classify(
    evidence("Eis ist kalt.", 0.04, 0.92, 0.04),
  )
  assert.equal(result.status, "missed")
})

test("classifyCriterion keeps near-threshold entailment uncertain", () => {
  const result = classify(
    evidence("Vielleicht ist Eis weniger dicht.", 0.65, 0.27, 0.08),
  )
  assert.equal(result.status, "uncertain")
})

test("classifyCriterion treats an entailed misconception as contradiction", () => {
  const misconception = evidence(
    "Eis ist dichter als Wasser.",
    0.96,
    0.02,
    0.02,
    "Eis hat eine höhere Dichte als Wasser.",
  )
  const result = classify(
    evidence("Eis schwimmt.", 0.08, 0.88, 0.04),
    evidence("Eis schwimmt.", 0.08, 0.88, 0.04),
    misconception,
  )
  assert.equal(result.status, "contradicted")
  assert.equal(result.misconceptionEntailment, 0.96)
})

test("classifyCriterion accepts a double-negation reading when NLI entails it", () => {
  const result = classify(
    evidence("Es stimmt nicht, dass Eis nicht weniger dicht ist.", 0.88, 0.08, 0.04),
    evidence("Es stimmt nicht, dass Eis nicht weniger dicht ist.", 0.88, 0.08, 0.04),
    evidence(
      "Es stimmt nicht, dass Eis nicht weniger dicht ist.",
      0.03,
      0.07,
      0.9,
      "Eis hat eine höhere Dichte als Wasser.",
    ),
  )
  assert.equal(result.status, "met")
})

test("default calibration preserves the verified Xenova NLI sanity decisions", () => {
  const defaultCriterion = normalizeRequest({
    question: "Warum schwimmt Eis?",
    answer: "Browser-Testantwort",
    reference: "Eis besitzt eine geringere Dichte als flüssiges Wasser.",
  }).criteria[0]!
  const classifyDefault = (
    entailment: number,
    neutral: number,
    contradiction: number,
  ): CriterionResult => {
    const nliEvidence: NliEvidence = {
      text: "Testantwort",
      hypothesis: defaultCriterion.text,
      entailment,
      neutral,
      contradiction,
    }
    return classifyCriterion({
      criterion: defaultCriterion,
      supportEvidence: nliEvidence,
      contradictionEvidence: nliEvidence,
      uncertaintyMargin: 0.1,
      contrastiveMargin: 0.15,
    })
  }

  assert.equal(classifyDefault(0.917328, 0.062713, 0.019959).status, "met")
  assert.equal(classifyDefault(0.075843, 0.060035, 0.864123).status, "contradicted")
  assert.equal(classifyDefault(0.163029, 0.213252, 0.623718).status, "uncertain")
  assert.equal(classifyDefault(0.064881, 0.920891, 0.014227).status, "missed")
})

test("holistic ice calibration accepts exactly the two intended full answers", () => {
  const reference =
    "Beim Gefrieren entsteht eine besondere Molekülstruktur, durch die Eis eine geringere Dichte als flüssiges Wasser hat. Deshalb schwimmt Eis auf Wasser."
  const calibratedCriterion = normalizeRequest({
    question: "Warum schwimmt Eis?",
    answer: "Vollständige Testantwort",
    reference,
    criterionThreshold: 0.66,
  }).criteria[0]!
  const cases: Array<{
    answer: string
    entailment: number
    neutral: number
    contradiction: number
    expected: boolean
  }> = [
    {
      answer:
        "Wasser gefriert, indem es hexagonale Molekülmuster ausbildet. Dies wird die Anomalie des Wasser genannt und entspringt seinem Dipolcharakter. Aus diesem Grund nimmt die Dichte von Wasser im festen Zustand ab und schwimmt auf noch flüssigem Wasser.",
      entailment: 0.6915,
      neutral: 0.2733,
      contradiction: 0.0353,
      expected: true,
    },
    {
      answer:
        "Wasser hat eine größere Dichte als Eis, da Eis durch die Wasserstoffbrückenbindung sich beim Gefrieren besonders anordnet und somit mehr Volumen pro Molekül braucht. Durch die geringere Dichte von Eis schwimmt es auf dem Wasser.",
      entailment: 0.7194,
      neutral: 0.235,
      contradiction: 0.0456,
      expected: true,
    },
    {
      answer:
        "Eis hat eine höhere Dichte als Wasser, was daran liegt, dass es fest ist und bei festen Stoffen ist die Temperatur niedriger.",
      entailment: 0.0885,
      neutral: 0.7978,
      contradiction: 0.1137,
      expected: false,
    },
    {
      answer: "Wasser dehnt sich beim Gefrieren aus, deswegen sinkt die Dichte.",
      entailment: 0.3274,
      neutral: 0.6224,
      contradiction: 0.0502,
      expected: false,
    },
    {
      answer:
        "Eis ist zwar leichter als Wasser, aber Wasser stößt Eis ab, sodass Eis immer auf dem Wasser sein muss.",
      entailment: 0.2631,
      neutral: 0.6945,
      contradiction: 0.0424,
      expected: false,
    },
    {
      answer:
        "Wasser ist paramagnetisch und durch die Wirbelströme im Eis kommt es durch die Lenz’sche Regel zu einer ursachenentgegenwirkenden Kraft, sodass dadurch ein Auftrieb entsteht.",
      entailment: 0.1104,
      neutral: 0.8283,
      contradiction: 0.0613,
      expected: false,
    },
    {
      answer: "Weil es gefriert und deswegen halt oben schwimmt.",
      entailment: 0.2632,
      neutral: 0.6726,
      contradiction: 0.0642,
      expected: false,
    },
    {
      answer:
        "Weil die Luft über dem Wasser halt so kalt ist, muss das Eis ja auch oben sein.",
      entailment: 0.0735,
      neutral: 0.8865,
      contradiction: 0.0401,
      expected: false,
    },
  ]

  const decisions = cases.map((testCase) => {
    const nliEvidence: NliEvidence = {
      text: testCase.answer,
      hypothesis: reference,
      entailment: testCase.entailment,
      neutral: testCase.neutral,
      contradiction: testCase.contradiction,
    }
    const classified = classifyCriterion({
      criterion: calibratedCriterion,
      supportEvidence: nliEvidence,
      contradictionEvidence: nliEvidence,
      uncertaintyMargin: 0.1,
      contrastiveMargin: 0.15,
    })
    return aggregateCriteria([classified], 1).passed
  })

  assert.deepEqual(
    decisions,
    cases.map((testCase) => testCase.expected),
  )
})

function result(
  id: string,
  status: CriterionResult["status"],
  required = false,
): CriterionResult {
  const base = evidence("Beleg", 0.8, 0.15, 0.05, id)
  return {
    id,
    label: id,
    status,
    entailment: 0.8,
    neutral: 0.15,
    contradiction: status === "contradicted" ? 0.9 : 0.05,
    misconceptionEntailment: null,
    supportEvidence: base,
    contradictionEvidence: base,
    evidenceKind: status === "contradicted" ? "contradiction" : "entailment",
    similarity: 0.8,
    misconceptionSimilarity: null,
    weight: 1,
    required,
    evidence: "Beleg",
  }
}

function evaluation(
  status: EvaluationResult["status"],
  criteria: CriterionResult[],
): EvaluationResult {
  return {
    status,
    passed: status === "passed",
    mode: "holistic",
    coverage: status === "passed" ? 1 : 0,
    potentialCoverage: status === "uncertain" ? 1 : 0,
    criteria,
    answer: "Testantwort",
    durationMs: 12,
    model: {
      id: "test/model",
      revision: "test",
      device: "wasm",
      dtype: "q8",
      task: "natural-language-inference",
    },
    notice: "Interner Hinweis, der nicht im Kurzfeedback stehen darf.",
  }
}

test("quality diagnostics use a stable priority and keep style advisory", () => {
  const style = result("style", "met")
  style.judgeFeedbackCode = "too-colloquial"
  style.judgeConfidence = 0.9
  assert.deepEqual(qualityDiagnosticForCriteria([style]), {
    code: "too-colloquial",
    confidence: 0.9,
    source: "quality",
    severity: "advisory",
  })

  const offTopic = result("topic", "missed")
  offTopic.judgeFeedbackCode = "off-topic"
  offTopic.judgeConfidence = 0.8
  const contentError = result("content", "contradicted")
  contentError.judgeFeedbackCode = "content-error"
  contentError.judgeConfidence = 0.7
  assert.equal(
    qualityDiagnosticForCriteria([style, offTopic, contentError])?.code,
    "content-error",
  )
})

test("automatic evaluator prefers cached quality, keeps uncached quality in the background, and falls back", async () => {
  class MockEvaluator {
    readonly status
    readonly modelId
    readonly cacheAvailable
    evaluateCalls = 0
    preloadCalls = 0
    preloadCaches: ModelCacheInfo[] = []
    preloadBarrier: Promise<void> | null = null
    unloadCalls = 0
    failEvaluation = false

    constructor(
      modelId: string,
      engine: "compact" | "quality",
      cacheAvailable = true,
    ) {
      this.modelId = modelId
      this.cacheAvailable = cacheAvailable
      this.status = {
        phase: "idle" as "idle" | "ready",
        assessmentEngine: engine,
        modelId,
        revision: "test",
        device: engine === "quality" ? ("webgpu" as const) : ("wasm" as const),
        dtype: engine === "quality" ? ("q4f16" as const) : ("q8" as const),
      }
    }

    configure() {
      return this.status
    }

    getStatus() {
      return this.status
    }

    async getCacheInfo() {
      return {
        supported: true,
        cached: this.cacheAvailable,
        downloadCached: this.cacheAvailable,
        filesCached: this.cacheAvailable ? 1 : 0,
        filesTotal: 1,
        estimatedBytes: 1,
      }
    }

    async preload(cacheInfo?: ModelCacheInfo) {
      this.preloadCalls += 1
      if (cacheInfo) this.preloadCaches.push(cacheInfo)
      if (this.preloadBarrier) await this.preloadBarrier
      this.status.phase = "ready"
      return this.status
    }

    async evaluate() {
      this.evaluateCalls += 1
      if (this.failEvaluation) throw new Error("invalid quality JSON")
      const value = evaluation("passed", [result("overall", "met", true)])
      value.model.id = this.modelId
      value.model.device = this.status.device
      value.model.dtype = this.status.dtype
      value.model.task =
        this.status.assessmentEngine === "quality"
          ? "generative-assessment"
          : "natural-language-inference"
      return value
    }

    async unloadRuntime() {
      this.unloadCalls += 1
    }

    async clearCache() {
      return 1
    }
  }

  const compact = new MockEvaluator("compact-test", "compact")
  const quality = new MockEvaluator("quality-test", "quality")
  let releaseQuality!: () => void
  quality.preloadBarrier = new Promise<void>((resolve) => {
    releaseQuality = resolve
  })
  const navigatorObject = globalThis.navigator
  const gpuDescriptor = Object.getOwnPropertyDescriptor(navigatorObject, "gpu")
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    navigatorObject,
    "storage",
  )
  const connectionDescriptor = Object.getOwnPropertyDescriptor(
    navigatorObject,
    "connection",
  )
  let persistCalls = 0
  Object.defineProperty(navigatorObject, "gpu", {
    configurable: true,
    value: {},
  })
  Object.defineProperty(navigatorObject, "storage", {
    configurable: true,
    value: {
      persisted: async () => false,
      persist: async () => {
        persistCalls += 1
        return true
      },
    },
  })
  Object.defineProperty(navigatorObject, "connection", {
    configurable: true,
    value: { type: "wifi", saveData: false },
  })

  try {
    const automatic = new AutomaticEvaluator(compact as never, quality as never)
    const request = {
      question: "Warum schwimmt Eis?",
      answer: "Eis hat eine geringere Dichte als flüssiges Wasser.",
      reference: "Eis hat eine geringere Dichte als flüssiges Wasser.",
    }

    const preparation = automatic.preload()
    let firstSettled = false
    const firstPromise = automatic.evaluate(request).then((value) => {
      firstSettled = true
      return value
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(firstSettled, false)
    assert.equal(compact.preloadCalls, 0)
    assert.equal(compact.evaluateCalls, 0)
    assert.equal(quality.preloadCalls, 1)
    assert.equal(quality.preloadCaches[0]?.cached, true)
    assert.equal(quality.preloadCaches[0]?.downloadCached, true)
    assert.equal(persistCalls, 0)
    releaseQuality()
    await preparation
    const first = await firstPromise
    assert.equal(first.model.id, "quality-test")

    const second = await automatic.evaluate(request)
    assert.equal(second.model.id, "quality-test")

    quality.failEvaluation = true
    const fallback = await automatic.evaluate(request)
    assert.equal(fallback.model.id, "compact-test")
    const compactCallsAfterFallback = compact.evaluateCalls

    const afterDegrade = await automatic.evaluate(request)
    assert.equal(afterDegrade.model.id, "compact-test")
    assert.equal(quality.evaluateCalls, 3)
    assert.equal(compact.evaluateCalls, compactCallsAfterFallback + 1)

    const networkCompact = new MockEvaluator(
      "compact-network-test",
      "compact",
      true,
    )
    const networkQuality = new MockEvaluator(
      "quality-network-test",
      "quality",
      false,
    )
    let releaseNetworkQuality!: () => void
    networkQuality.preloadBarrier = new Promise<void>((resolve) => {
      releaseNetworkQuality = resolve
    })
    const networkAutomatic = new AutomaticEvaluator(
      networkCompact as never,
      networkQuality as never,
    )
    await networkAutomatic.preload()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(networkQuality.preloadCalls, 1)

    let networkTimeout!: ReturnType<typeof setTimeout>
    const networkFirst = await Promise.race([
      networkAutomatic.evaluate(request),
      new Promise<never>((_resolve, reject) => {
        networkTimeout = setTimeout(
          () => reject(new Error("compact pass waited for quality download")),
          250,
        )
      }),
    ])
    clearTimeout(networkTimeout)
    assert.equal(networkFirst.model.id, "compact-network-test")
    assert.equal(networkCompact.evaluateCalls, 1)
    assert.equal(networkQuality.evaluateCalls, 0)
    assert.equal(persistCalls, 1)
    releaseNetworkQuality()
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    if (gpuDescriptor) {
      Object.defineProperty(navigatorObject, "gpu", gpuDescriptor)
    } else {
      delete (navigatorObject as Navigator & { gpu?: unknown }).gpu
    }
    if (storageDescriptor) {
      Object.defineProperty(navigatorObject, "storage", storageDescriptor)
    } else {
      delete (navigatorObject as Navigator & { storage?: StorageManager }).storage
    }
    if (connectionDescriptor) {
      Object.defineProperty(navigatorObject, "connection", connectionDescriptor)
    } else {
      delete (navigatorObject as Navigator & { connection?: unknown }).connection
    }
  }
})

test("automatic evaluator rechecks the same compact miss with quality before returning", async () => {
  class StagedMockEvaluator {
    readonly status: RuntimeStatus
    readonly resultStatus: EvaluationResult["status"]
    readonly cacheAvailable: boolean
    evaluateCalls = 0
    preloadCalls = 0
    preloadBarrier: Promise<void> | null = null
    unloadCalls = 0
    requests: EvaluationRequest[] = []

    constructor(
      modelId: string,
      engine: "compact" | "quality",
      resultStatus: EvaluationResult["status"],
      cacheAvailable = true,
    ) {
      this.resultStatus = resultStatus
      this.cacheAvailable = cacheAvailable
      this.status = {
        phase: "idle",
        assessmentEngine: engine,
        modelId,
        revision: "test",
        device: engine === "quality" ? "webgpu" : "wasm",
        dtype: engine === "quality" ? "q4f16" : "q8",
      }
    }

    configure() {
      return this.status
    }

    getStatus() {
      return this.status
    }

    async getCacheInfo(): Promise<ModelCacheInfo> {
      return {
        supported: true,
        cached: this.cacheAvailable,
        downloadCached: this.cacheAvailable,
        filesCached: this.cacheAvailable ? 1 : 0,
        filesTotal: 1,
        estimatedBytes: 1,
      }
    }

    async preload() {
      this.preloadCalls += 1
      if (this.preloadBarrier) await this.preloadBarrier
      this.status.phase = "ready"
      return this.status
    }

    async evaluate(request: EvaluationRequest) {
      this.evaluateCalls += 1
      this.requests.push({ ...request })
      const criterionStatus =
        this.resultStatus === "passed"
          ? "met"
          : this.resultStatus === "uncertain"
            ? "uncertain"
            : "missed"
      const value = evaluation(this.resultStatus, [
        result("overall", criterionStatus, true),
      ])
      value.answer = request.answer
      value.model.id = this.status.modelId
      value.model.device = this.status.device
      value.model.dtype = this.status.dtype
      value.model.task =
        this.status.assessmentEngine === "quality"
          ? "generative-assessment"
          : "natural-language-inference"
      return value
    }

    async unloadRuntime() {
      this.unloadCalls += 1
    }

    async clearCache() {
      return 1
    }
  }

  const compact = new StagedMockEvaluator(
    "compact-test",
    "compact",
    "failed",
  )
  const quality = new StagedMockEvaluator(
    "quality-test",
    "quality",
    "passed",
    false,
  )
  const navigatorObject = globalThis.navigator
  const gpuDescriptor = Object.getOwnPropertyDescriptor(navigatorObject, "gpu")
  const connectionDescriptor = Object.getOwnPropertyDescriptor(
    navigatorObject,
    "connection",
  )
  Object.defineProperty(navigatorObject, "gpu", {
    configurable: true,
    value: {},
  })
  Object.defineProperty(navigatorObject, "connection", {
    configurable: true,
    value: { type: "wifi", saveData: false },
  })

  const request: EvaluationRequest = {
    question: "Erkläre, warum Eis auf flüssigem Wasser schwimmt.",
    answer:
      "Beim Gefrieren ordnen sich die Wassermoleküle durch Wasserstoffbrücken zu einer offenen Kristallstruktur an. Diese Struktur benötigt mehr Volumen. Deshalb besitzt Eis eine geringere Dichte als flüssiges Wasser und schwimmt an der Oberfläche.",
    reference:
      "Beim Gefrieren entsteht eine besondere Molekülstruktur, durch die Eis eine geringere Dichte als flüssiges Wasser hat. Deshalb schwimmt Eis auf Wasser.",
    criterionThreshold: 0.66,
  }
  const phases: EvaluationProgressPhase[] = []

  try {
    const automatic = new AutomaticEvaluator(compact as never, quality as never)
    const resultValue = await automatic.evaluate(request, {
      onProgress: (progress) => phases.push(progress.phase),
    })

    assert.equal(resultValue.passed, true)
    assert.equal(resultValue.model.id, "quality-test")
    assert.equal(compact.evaluateCalls, 1)
    assert.equal(quality.evaluateCalls, 1)
    assert.equal(compact.requests[0]?.answer, request.answer)
    assert.equal(quality.requests[0]?.answer, request.answer)
    assert.equal(compact.requests[0]?.reference, request.reference)
    assert.equal(quality.requests[0]?.reference, request.reference)
    assert.deepEqual(phases, [
      "selecting-model",
      "preparing-compact",
      "evaluating-compact",
      "preparing-quality",
      "evaluating-quality",
    ])

    const abortCompact = new StagedMockEvaluator(
      "compact-abort-test",
      "compact",
      "failed",
    )
    const abortQuality = new StagedMockEvaluator(
      "quality-abort-test",
      "quality",
      "passed",
      false,
    )
    let releaseAbortedUpgrade!: () => void
    abortQuality.preloadBarrier = new Promise<void>((resolve) => {
      releaseAbortedUpgrade = resolve
    })
    const aborting = new AutomaticEvaluator(
      abortCompact as never,
      abortQuality as never,
    )
    const controller = new AbortController()
    const pending = aborting.evaluate(request, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await assert.rejects(pending, { name: "AbortError" })
    releaseAbortedUpgrade()
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    if (gpuDescriptor) {
      Object.defineProperty(navigatorObject, "gpu", gpuDescriptor)
    } else {
      delete (navigatorObject as Navigator & { gpu?: unknown }).gpu
    }
    if (connectionDescriptor) {
      Object.defineProperty(navigatorObject, "connection", connectionDescriptor)
    } else {
      delete (navigatorObject as Navigator & { connection?: unknown }).connection
    }
  }
})

test("learner feedback stays short and never exposes criteria or scores", () => {
  assert.equal(feedbackForResult(evaluation("passed", [result("secret", "met")])), null)

  const contradiction = feedbackForResult(
    evaluation("failed", [result("geheimes-kriterium", "contradicted")]),
  )
  assert.equal(contradiction?.code, "content-error")
  assert.equal(contradiction?.message, "Die Antwort enthält inhaltliche Fehler.")
  assert.doesNotMatch(
    contradiction?.message ?? "",
    /geheimes-kriterium|Bestätigung|Konfidenz|Interner Hinweis|Musterlösung/u,
  )

  assert.equal(
    feedbackForResult(evaluation("uncertain", [result("secret", "uncertain")]))?.code,
    "unclear",
  )
  assert.equal(
    feedbackForResult(evaluation("uncertain", [result("secret", "uncertain")]))
      ?.message,
    "Die Antwort ist noch nicht eindeutig genug. Formuliere den Zusammenhang klarer.",
  )
  assert.equal(
    feedbackForResult(evaluation("failed", [result("secret", "missed")]))?.code,
    "incomplete",
  )
  assert.equal(
    feedbackForResult(evaluation("failed", [result("secret", "missed")]))
      ?.message,
    "Die Antwort erklärt den gefragten Zusammenhang noch nicht vollständig.",
  )

  const offTopicCriterion = result("secret", "missed")
  offTopicCriterion.judgeDecision = "fail_off_topic"
  assert.equal(
    feedbackForResult(evaluation("failed", [offTopicCriterion]))?.code,
    "off-topic",
  )
  assert.equal(
    feedbackForResult(evaluation("failed", [offTopicCriterion]))?.message,
    "Die Antwort geht noch nicht auf die gestellte Frage ein.",
  )

  const colloquial = evaluation("passed", [result("secret", "met")])
  colloquial.diagnostic = {
    code: "too-colloquial",
    source: "quality",
    severity: "advisory",
  }
  assert.deepEqual(feedbackForResult(colloquial), {
    code: "too-colloquial",
    message: "Die Antwort ist zu umgangssprachlich verfasst.",
  })

  const failedWithStyle = evaluation("failed", [result("secret", "missed")])
  failedWithStyle.diagnostic = {
    code: "too-colloquial",
    source: "quality",
    severity: "advisory",
  }
  assert.equal(feedbackForResult(failedWithStyle)?.code, "incomplete")

  const operatorNotMet = evaluation("failed", [result("secret", "missed")])
  operatorNotMet.operator = normalizeRequest({
    question: "Erkläre den Zusammenhang.",
    answer: "Das ist eine ausreichend lange Testantwort.",
    reference: "Eine vollständige Erklärung des Zusammenhangs.",
    operator: "erklaeren",
  }).operator
  operatorNotMet.diagnostic = {
    code: "operator-not-met",
    source: "quality",
    severity: "blocking",
  }
  assert.equal(
    feedbackForResult(operatorNotMet)?.message,
    "Die Antwort entspricht noch nicht den Kriterien einer Erklärung.",
  )
})

test("formatResult hides criterion details by default but keeps them available", () => {
  const evaluation: EvaluationResult = {
    status: "failed",
    passed: false,
    mode: "holistic",
    coverage: 0,
    potentialCoverage: 0,
    criteria: [result("density", "missed")],
    answer: "Eis ist kalt.",
    durationMs: 12,
    model: {
      id: "test/model",
      revision: "test",
      device: "wasm",
      dtype: "q8",
      task: "natural-language-inference",
    },
    notice: "Nur ein formativer Selbstcheck.",
  }

  const compact = formatResult(evaluation, "de-DE")
  assert.doesNotMatch(compact, /density|Bestätigung:/u)
  assert.match(compact, /Gesamtzusammenhang/u)
  assert.equal(evaluation.criteria[0]?.id, "density")

  const detailed = formatResult(evaluation, "de-DE", { showCriteria: true })
  assert.match(detailed, /density/u)
  assert.match(detailed, /Bestätigung:/u)
})

test("LLMQuiz has one public macro with named and positional options", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  const publicDefinitions = readme.match(/^@LLMQuiz[^_\n]*:/gmu) ?? []
  assert.deepEqual(publicDefinitions, ["@LLMQuiz:"])
  assert.match(readme, /^@LLMQuiz: @LLMQuiz_\(@uid,@0,```@1```\)$/mu)
  assert.match(readme, /@LLMQuiz\(0\.66;solution=1;feedback=1\)/u)
  assert.match(readme, /@LLMQuiz\(0\.66;1;1\)/u)
  assert.match(readme, /@LLMQuiz\(0\.66;1;1;erklaeren\)/u)
  assert.match(
    readme,
    /^```text @LLMQuiz\(0\.66;solution=1;feedback=1;operator=erklaeren\)$/mu,
  )
  assert.doesNotMatch(readme, /^```text\r?\n@LLMQuiz\(/mu)
  assert.doesNotMatch(readme, /@LLMQuiz\.(?:compact|withFeedback|noSolution)/u)

  assert.match(readme, /\.feedbackForResult\?\.\(result, "de-DE"\)/u)
  assert.match(readme, /\.feedbackForError\?\.\(error, "de-DE"\)/u)
  assert.match(readme, /\.showFeedback\?\.\(feedbackId,/u)
  assert.match(readme, /\.showActivity\?\.\(activityId, runId,/u)
  assert.match(
    readme,
    /\.showActivity\?\.\(activityId, runId, "selecting-model"\)/u,
  )
  assert.match(readme, /parseMacroOptions\(optionSource\)/u)
  assert.match(readme, /finishQuiz\(result\.passed \? "true" : "false"\)/u)
  assert.match(readme, /send\.handle\("stop",/u)
  assert.match(readme, /evaluationController\.abort\(\)/u)
  assert.match(readme, /signal: evaluationController\.signal/u)
  assert.match(readme, /onProgress: progress =>/u)
  assert.match(readme, /if \(!active \|\| finished\) return/u)
  assert.match(readme, /criterionThreshold: options\.passThreshold/u)
  assert.match(readme, /operator: options\.operator \?\? undefined/u)
  assert.doesNotMatch(readme, /feedbackEnabled && !result\.passed/u)
  assert.doesNotMatch(readme, /assessmentEngine,/u)
  assert.doesNotMatch(readme, /send\.lia\(feedback\.message, \[\], false\)/u)

  const macro = readme.match(
    /\n@LLMQuiz_\n([\s\S]*?)\n@end/u,
  )?.[1]
  assert.ok(macro)
  assert.match(
    macro,
    /<lia-llm-feedback id="lia-llm-feedback-@0"><\/lia-llm-feedback>/u,
  )
  assert.match(
    macro,
    /<script output="lia-llm-result-@0">/u,
  )
  assert.match(
    macro,
    /<lia-llm-activity id="lia-llm-activity-@0" hidden><\/lia-llm-activity>/u,
  )
  assert.match(
    macro,
    /<lia-llm-quiz-use hidden><\/lia-llm-quiz-use>/u,
  )
  assert.doesNotMatch(macro, /^\*{16,}$/mu)
  assert.doesNotMatch(macro, /showSolution/u)
  assert.doesNotMatch(macro, /<lia-llm-solution/u)
  assert.match(
    macro,
    /const solutionResult = "@input\(`lia-llm-result-@0`\)"/u,
  )
  assert.match(
    macro,
    /solutionResult === "true" && solutionOptions\?\.solution/u,
  )
  assert.match(macro, /send\.liascript\(solutionReference\)/u)
  assert.match(macro, /send\.clear\(\)/u)
  assert.match(
    readme,
    /vollständig als LiaScript neu geparst[\s\S]*Inline- und Blockformeln in TeX/u,
  )
  assert.match(readme, /data-solution-button="off"/u)

  const validatorScript = macro.match(
    /<script output="lia-llm-result-@0">\n([\s\S]*?)\n<\/script>/u,
  )?.[1]
  assert.ok(validatorScript)
  assert.doesNotThrow(() => new Function(validatorScript))

  const solutionScript = macro.match(
    /<script style="display:block" modify="false">\n([\s\S]*?)\n<\/script>/u,
  )?.[1]
  assert.ok(solutionScript)
  assert.doesNotThrow(() => new Function(solutionScript))
})

test("operator documentation lists every active runtime profile", () => {
  const documentation = readFileSync(
    new URL("../docs/operatoren.md", import.meta.url),
    "utf8",
  )
  assert.match(documentation, /schema: lia-llm-operator-profiles\/v1/u)
  for (const rubric of supportedOperatorRubrics()) {
    assert.ok(
      documentation.includes("| `" + rubric.id + "` | aktiv |"),
      "Fehlendes aktives Dokumentationsprofil: " + rubric.id,
    )
  }
})

test("aggregateCriteria keeps uncertain cases out of automatic passing", () => {
  const assessment = aggregateCriteria(
    [result("one", "met"), result("two", "uncertain")],
    1,
  )
  assert.equal(assessment.status, "uncertain")
  assert.equal(assessment.passed, false)
  assert.equal(assessment.coverage, 0.5)
  assert.equal(assessment.potentialCoverage, 1)
})

test("aggregateCriteria allows omitted optional content at a fractional threshold", () => {
  const assessment = aggregateCriteria(
    [result("one", "met"), result("two", "met"), result("three", "missed")],
    0.66,
  )
  assert.equal(assessment.status, "passed")
  assert.equal(assessment.passed, true)
})

test("aggregateCriteria never passes an explicit contradiction", () => {
  const assessment = aggregateCriteria(
    [result("one", "met"), result("two", "met"), result("three", "contradicted")],
    0.66,
  )
  assert.equal(assessment.status, "failed")
  assert.equal(assessment.passed, false)
})

test("aggregateCriteria enforces required criteria", () => {
  const assessment = aggregateCriteria(
    [result("required", "missed", true), result("optional", "met")],
    0.5,
  )
  assert.equal(assessment.status, "failed")
})

test("quiz input encoding preserves textarea paragraphs losslessly", () => {
  const encoded = toQuizInputValue("Erster Absatz.\r\n\r\nZweiter Absatz.")
  assert.equal(encoded, "Erster Absatz.\u2028\u2028Zweiter Absatz.")
  assert.equal(fromQuizInputValue(encoded), "Erster Absatz.\n\nZweiter Absatz.")
})

test("parseTextareaRows applies defaults and safe limits", () => {
  assert.equal(parseTextareaRows(null), 5)
  assert.equal(parseTextareaRows("1"), 2)
  assert.equal(parseTextareaRows("7"), 7)
  assert.equal(parseTextareaRows("99"), 12)
})

test("parseMacroOptions supports named and positional quiz options", () => {
  assert.deepEqual(parseMacroOptions("0.66;solution=1;feedback=true"), {
    passThreshold: 0.66,
    solution: true,
    feedback: true,
    operator: null,
  })
  assert.deepEqual(parseMacroOptions("0.66;0;1"), {
    passThreshold: 0.66,
    solution: false,
    feedback: true,
    operator: null,
  })
  assert.deepEqual(
    parseMacroOptions("0.66;feedback=1;operator=erklären;solution=0"),
    {
      passThreshold: 0.66,
      solution: false,
      feedback: true,
      operator: "erklaeren",
    },
  )
  assert.deepEqual(parseMacroOptions("0.66;1;1;erklaeren"), {
    passThreshold: 0.66,
    solution: true,
    feedback: true,
    operator: "erklaeren",
  })
})

test("parseMacroOptions applies backward-compatible defaults", () => {
  assert.deepEqual(parseMacroOptions("0.66"), {
    passThreshold: 0.66,
    solution: true,
    feedback: false,
    operator: null,
  })
  assert.deepEqual(parseMacroOptions("1;feedback=1"), {
    passThreshold: 1,
    solution: true,
    feedback: true,
    operator: null,
  })
})

test("parseMacroOptions rejects ambiguous or invalid input", () => {
  assert.throws(() => parseMacroOptions("0.66;1;feedback=1"), /nicht gemischt/u)
  assert.throws(() => parseMacroOptions("0.66;solution=1;solution=0"), /mehrfach/u)
  assert.throws(() => parseMacroOptions("0.66;unknown=1"), /Unbekannte/u)
  assert.throws(
    () => parseMacroOptions("0.66;operator=erläutern"),
    /noch nicht unterstützt/u,
  )
  assert.throws(() => parseMacroOptions("0.66;solution=on"), /0, 1, true oder false/u)
  assert.throws(() => parseMacroOptions("1.01"), /zwischen 0 und 1/u)
  assert.throws(() => parseMacroOptions("0.66;"), /Leere Makrooptionen/u)
})

test("download policy asks before mobile or uncertain large downloads", () => {
  const baseNetwork = {
    online: true,
    saveData: false,
    connectionType: null,
    mobile: false,
  }

  assert.equal(
    decideModelDownload({
      engine: "compact",
      cached: false,
      network: { ...baseNetwork, connectionType: "cellular", mobile: true },
    }),
    "consent",
  )
  assert.equal(
    decideModelDownload({
      engine: "compact",
      cached: false,
      network: { ...baseNetwork, saveData: true },
    }),
    "consent",
  )
  assert.equal(
    decideModelDownload({
      engine: "quality",
      cached: false,
      network: baseNetwork,
    }),
    "consent",
  )
  assert.equal(
    decideModelDownload({
      engine: "compact",
      cached: false,
      network: { ...baseNetwork, mobile: true },
    }),
    "consent",
  )
})

test("download policy reuses cache offline and auto-loads only safe cases", () => {
  const offline = {
    online: false,
    saveData: false,
    connectionType: null,
    mobile: true,
  }
  assert.equal(
    decideModelDownload({
      engine: "quality",
      cached: true,
      network: offline,
    }),
    "auto",
  )
  assert.equal(
    decideModelDownload({
      engine: "compact",
      cached: false,
      network: offline,
    }),
    "skip",
  )
  assert.equal(
    decideModelDownload({
      engine: "quality",
      cached: false,
      network: { ...offline, online: true, connectionType: "wifi" },
    }),
    "auto",
  )
  assert.equal(
    decideModelDownload({
      engine: "compact",
      cached: false,
      network: { ...offline, online: true, mobile: false },
    }),
    "auto",
  )
})

test("quiz textarea keeps all arrow keys inside the answer field", () => {
  assert.equal(isQuizTextareaNavigationKey("ArrowLeft"), true)
  assert.equal(isQuizTextareaNavigationKey("ArrowRight"), true)
  assert.equal(isQuizTextareaNavigationKey("ArrowUp"), true)
  assert.equal(isQuizTextareaNavigationKey("ArrowDown"), true)
  assert.equal(isQuizTextareaNavigationKey("a"), false)
})

test("progressPercent follows Transformers.js percentages and byte progress", () => {
  assert.equal(progressPercent({ status: "progress", progress: 42 }), 42)
  assert.equal(
    progressPercent({
      status: "progress",
      progress: 1,
      loaded: 25,
      total: 100,
    }),
    25,
  )
  assert.equal(progressPercent({ status: "progress", progress: 125 }), 100)
  assert.equal(progressPercent({ status: "initiate" }), null)
})
