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
import { formatResult } from "../src/format.ts"
import {
  fromQuizInputValue,
  parseTextareaRows,
  toQuizInputValue,
} from "../src/quiz-textarea.ts"
import { progressPercent } from "../src/load-overlay.ts"
import type {
  Criterion,
  CriterionResult,
  EvaluationResult,
  NliEvidence,
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

test("LLMQuiz uses only LiaScript's native quiz feedback", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  assert.doesNotMatch(readme, /window\.LiaLLM(?:\?\.)?\.showFeedback/u)
  assert.doesNotMatch(readme, /<lia-llm-feedback\b/u)
  assert.doesNotMatch(readme, /@LLMQuiz\.withId/u)
  assert.match(readme, /\.then\(result => send\.lia\(String\(result\.passed\)\)\)/u)
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
