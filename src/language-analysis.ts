import type {
  LanguageAnalysisOptions,
  LanguageAnalysisResult,
  NormalizedLanguageAnalysisOptions,
} from "./types.ts"

// Keep word counts identical across browsers and runtimes. Intl.Segmenter can
// split compounds and punctuation-bound forms differently depending on ICU.
const WORD_PATTERN =
  /(?:\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{M}\p{N}]+(?:['’\u2010\u2011-][\p{L}\p{M}\p{N}]+)*)/gu

export function normalizeLanguageAnalysisOptions(
  options: LanguageAnalysisOptions | undefined,
): NormalizedLanguageAnalysisOptions | undefined {
  if (options === undefined) return undefined
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("languageAnalysis muss ein Optionsobjekt sein.")
  }
  for (const name of ["spelling", "syntax"] as const) {
    const value = options[name]
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`languageAnalysis.${name} muss true oder false sein.`)
    }
  }
  const normalized = {
    spelling: options.spelling === true,
    syntax: options.syntax === true,
  }
  return normalized.spelling || normalized.syntax ? normalized : undefined
}

export function countWords(text: string): number {
  const normalized = text.normalize("NFKC").trim()
  if (!normalized) return 0
  return normalized.match(WORD_PATTERN)?.length ?? 0
}

export function unavailableLanguageAnalysis(
  answer: string,
  options: NormalizedLanguageAnalysisOptions,
): LanguageAnalysisResult {
  return {
    ...options,
    status: "unavailable",
    wordCount: countWords(answer),
  }
}
