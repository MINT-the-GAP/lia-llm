import type {
  CriterionResult,
  EvaluationResult,
  ResultFormatOptions,
} from "./types.ts"

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

function percentage(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value)
}

function criterionHtml(result: CriterionResult, locale: string, german: boolean): string {
  const icon =
    result.status === "met"
      ? "✅"
      : result.status === "contradicted"
        ? "❌"
        : result.status === "uncertain"
          ? "⚠️"
          : "○"
  const state = german
    ? result.status === "met"
      ? "bestätigt"
      : result.status === "contradicted"
        ? "widersprüchlich"
        : result.status === "uncertain"
          ? "nicht eindeutig"
          : "nicht belegt"
    : result.status === "met"
      ? "supported"
      : result.status === "contradicted"
        ? "contradicted"
        : result.status === "uncertain"
          ? "uncertain"
          : "not supported"
  const feedback =
    result.status !== "met" && result.feedback
      ? `<div>${escapeHtml(result.feedback)}</div>`
      : ""
  const evidenceLabel =
    result.evidenceKind === "contradiction"
      ? german
        ? "Widerspruchspassage"
        : "Contradicting passage"
      : german
        ? "Beleg"
        : "Evidence"
  const evidence = result.evidence
    ? `<small>${evidenceLabel}: “${escapeHtml(result.evidence)}”</small>`
    : ""
  const scores = german
    ? `Bestätigung: ${percentage(result.entailment, locale)}, neutral: ${percentage(result.neutral, locale)}, Widerspruch: ${percentage(result.contradiction, locale)}`
    : `entailment: ${percentage(result.entailment, locale)}, neutral: ${percentage(result.neutral, locale)}, contradiction: ${percentage(result.contradiction, locale)}`

  return `<li style="margin:.45rem 0"><strong>${icon} ${escapeHtml(result.label)}</strong> – ${state} <small>(${scores})</small>${feedback}${evidence}</li>`
}

export function formatResult(
  result: EvaluationResult,
  locale = "de-DE",
  options: ResultFormatOptions = {},
): string {
  const german = locale.toLowerCase().startsWith("de")
  const hasContradiction = result.criteria.some(
    (criterion) => criterion.status === "contradicted",
  )
  const heading =
    result.mode === "holistic"
      ? german
        ? hasContradiction
          ? "Die Antwort widerspricht der Musterlösung im Gesamtzusammenhang."
          : result.status === "passed"
            ? "Die Antwort stimmt im Gesamtzusammenhang mit der Musterlösung überein."
            : result.status === "uncertain"
              ? "Die Antwort lässt sich im Gesamtzusammenhang nicht sicher einordnen."
              : "Die Antwort stimmt im Gesamtzusammenhang noch nicht ausreichend mit der Musterlösung überein."
        : hasContradiction
          ? "The answer contradicts the reference answer in its overall context."
          : result.status === "passed"
            ? "The answer agrees with the reference answer in its overall context."
            : result.status === "uncertain"
              ? "The answer cannot be classified confidently in its overall context."
              : "The answer does not yet agree sufficiently with the reference answer in its overall context."
      : german
        ? hasContradiction
          ? "Die Antwort enthält mindestens einen fachlichen Widerspruch."
          : result.status === "passed"
            ? "Die Antwort deckt die geforderten Aspekte ab."
            : result.status === "uncertain"
              ? "Die Antwort liegt in der Unsicherheitszone."
              : "Einige geforderte Aspekte sind noch nicht belegt."
        : hasContradiction
          ? "The answer contains at least one substantive contradiction."
          : result.status === "passed"
            ? "The answer covers the required aspects."
            : result.status === "uncertain"
              ? "The answer is in the uncertainty zone."
              : "Some required aspects are not supported yet."
  const color =
    result.status === "passed"
      ? "#16794a"
      : result.status === "uncertain"
        ? "#946200"
        : "#a12b2b"
  const label = german ? "Sicher bestätigte Abdeckung" : "Clearly supported coverage"
  const details =
    options.showCriteria === true
      ? `<div>${label}: ${percentage(result.coverage, locale)}</div><ul style="padding-left:1.3rem">${result.criteria.map((criterion) => criterionHtml(criterion, locale, german)).join("")}</ul>`
      : ""

  return `<section role="status" aria-live="polite" style="border-left:.35rem solid ${color};padding:.65rem .85rem;margin:.5rem 0"><strong>${heading}</strong>${details}<small style="display:block;margin-top:.35rem">${escapeHtml(result.notice)}</small></section>`
}
