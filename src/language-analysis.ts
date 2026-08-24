import type {
  LanguageAnalysisOptions,
  LanguageAnalysisResult,
  NormalizedLanguageAnalysisOptions,
  OrthographyCorrection,
  OrthographyCorrectionEdit,
  OrthographyCorrectionKind,
  OrthographyCorrectionPart,
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

export const MAX_ORTHOGRAPHY_CORRECTION_EDITS = 24

const MAX_ORTHOGRAPHY_EDIT_CHARACTERS = 64
const WORD_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}]/u
const WORD_CONNECTOR_PATTERN = /['\u2019\u2010\u2011-]/u
const SPELLING_VALUE_PATTERN =
  /^[\p{L}\p{M}]+(?:['\u2019\u2010\u2011-][\p{L}\p{M}]+)*$/u
const SPELLING_TOKEN_PATTERN =
  /[\p{L}\p{M}]+(?:['\u2019\u2010\u2011-][\p{L}\p{M}]+)*/gu
const PUNCTUATION_VALUE_PATTERN = /^[\p{P}\p{Zs}\t]*$/u
const PUNCTUATION_CHARACTER_PATTERN = /\p{P}/u
const UNSAFE_MARKUP_PUNCTUATION_PATTERN = /[<>{}\[\]_*#\x60~\\]/u

interface ResolvedOrthographyEdit extends OrthographyCorrectionEdit {
  start: number
  end: number
}

function correctionError(message: string): Error {
  return new Error("Ungültige Orthografie-Korrektur: " + message)
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

function codePointColumnToCodeUnitOffset(
  line: string,
  column: number,
): number | undefined {
  const points = Array.from(line)
  if (column > points.length) return undefined
  return points.slice(0, column).join("").length
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && WORD_CHARACTER_PATTERN.test(value)
}

function adjacentCodePoint(
  text: string,
  offset: number,
  direction: -1 | 1,
): string | undefined {
  if (direction === 1) return Array.from(text.slice(offset))[0]
  const points = Array.from(text.slice(0, offset))
  return points[points.length - 1]
}

function hasWholeWordBoundaries(
  answer: string,
  start: number,
  end: number,
): boolean {
  const before = Array.from(answer.slice(0, start))
  const after = Array.from(answer.slice(end))
  const beforeLast = before[before.length - 1]
  const beforeConnector = WORD_CONNECTOR_PATTERN.test(beforeLast ?? "") &&
    isWordCharacter(before[before.length - 2])
  const afterFirst = after[0]
  const afterConnector = WORD_CONNECTOR_PATTERN.test(afterFirst ?? "") &&
    isWordCharacter(after[1])
  return (
    !isWordCharacter(beforeLast) &&
    !beforeConnector &&
    !isWordCharacter(afterFirst) &&
    !afterConnector
  )
}

function damerauLevenshtein(left: string, right: string): number {
  const source = Array.from(left)
  const target = Array.from(right)
  const rows = source.length + 1
  const columns = target.length + 1
  const matrix = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(0)
  )
  for (let row = 0; row < rows; row += 1) matrix[row]![0] = row
  for (let column = 0; column < columns; column += 1) {
    matrix[0]![column] = column
  }
  for (let row = 1; row < rows; row += 1) {
    const currentRow = matrix[row]!
    const previousRow = matrix[row - 1]!
    for (let column = 1; column < columns; column += 1) {
      const cost = source[row - 1] === target[column - 1] ? 0 : 1
      currentRow[column] = Math.min(
        previousRow[column]! + 1,
        currentRow[column - 1]! + 1,
        previousRow[column - 1]! + cost,
      )
      if (
        row > 1 &&
        column > 1 &&
        source[row - 1] === target[column - 2] &&
        source[row - 2] === target[column - 1]
      ) {
        currentRow[column] = Math.min(
          currentRow[column]!,
          matrix[row - 2]![column - 2]! + 1,
        )
      }
    }
  }
  return matrix[source.length]![target.length]!
}

function spellingTokens(value: string): string[] {
  return value.match(SPELLING_TOKEN_PATTERN) ?? []
}

function validateSpellingEdit(
  answer: string,
  edit: ResolvedOrthographyEdit,
): void {
  if (
    !edit.source ||
    !edit.replacement ||
    !SPELLING_VALUE_PATTERN.test(edit.source) ||
    !SPELLING_VALUE_PATTERN.test(edit.replacement) ||
    codePointLength(edit.source) < 2 ||
    codePointLength(edit.replacement) < 2
  ) {
    throw correctionError("eine Rechtschreibänderung ist kein Wortersatz")
  }
  if (!hasWholeWordBoundaries(answer, edit.start, edit.end)) {
    throw correctionError("eine Rechtschreibänderung liegt nicht auf Wortgrenzen")
  }

  const sourceTokens = spellingTokens(edit.source)
  const replacementTokens = spellingTokens(edit.replacement)
  const sourceToken = sourceTokens[0]
  const replacementToken = replacementTokens[0]
  if (
    sourceTokens.length !== 1 ||
    replacementTokens.length !== 1 ||
    sourceToken === undefined ||
    replacementToken === undefined
  ) {
    throw correctionError("eine Rechtschreibänderung muss genau ein Wort ersetzen")
  }
  const source = sourceToken.normalize("NFC").toLocaleLowerCase("de-DE")
  const replacement = replacementToken
    .normalize("NFC")
    .toLocaleLowerCase("de-DE")
  if (source === replacement) return
  const longest = Math.max(codePointLength(source), codePointLength(replacement))
  const maximumDistance = Math.max(1, Math.min(3, Math.floor(longest / 3)))
  if (damerauLevenshtein(source, replacement) <= maximumDistance) return
  throw correctionError("ein Rechtschreibersatz verändert das Wort zu stark")
}

function validatePunctuationEdit(
  answer: string,
  edit: ResolvedOrthographyEdit,
): void {
  if (
    !PUNCTUATION_VALUE_PATTERN.test(edit.source) ||
    !PUNCTUATION_VALUE_PATTERN.test(edit.replacement) ||
    (!PUNCTUATION_CHARACTER_PATTERN.test(edit.source) &&
      !PUNCTUATION_CHARACTER_PATTERN.test(edit.replacement)) ||
    UNSAFE_MARKUP_PUNCTUATION_PATTERN.test(edit.source) ||
    UNSAFE_MARKUP_PUNCTUATION_PATTERN.test(edit.replacement)
  ) {
    throw correctionError("eine Zeichensetzungsänderung enthält unzulässige Zeichen")
  }
  if (
    edit.source.length === 0 &&
    isWordCharacter(adjacentCodePoint(answer, edit.start, -1)) &&
    isWordCharacter(adjacentCodePoint(answer, edit.start, 1))
  ) {
    throw correctionError("ein Satzzeichen darf nicht mitten in ein Wort eingefügt werden")
  }
}

function protectedRanges(answer: string): Array<{ start: number; end: number }> {
  const patterns = [
    /https?:\/\/[^\s]+|www\.[^\s]+/giu,
    /\x60{3}[\s\S]*?(?:\x60{3}|$)|~{3}[\s\S]*?(?:~{3}|$)/gu,
    /\x60[^\x60\n]*\x60/gu,
    /<(?:code|pre)\b[^>]*>[\s\S]*?(?:<\/(?:code|pre)\s*>|$)/giu,
    /<[^>\n]+>/gu,
    /&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/giu,
    /\$\$[^$]*\$\$|\$[^$\n]+\$/gu,
    /\\\([^)\n]*\\\)|\\\[[^\]\n]*\\\]/gu,
    /\\[a-z]+/giu,
  ]
  const ranges: Array<{ start: number; end: number }> = []
  for (const pattern of patterns) {
    for (const match of answer.matchAll(pattern)) {
      if (match.index === undefined) continue
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }
  return ranges
}

function editTouchesProtectedRange(
  edit: ResolvedOrthographyEdit,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) =>
    edit.start === edit.end
      ? edit.start >= range.start && edit.start < range.end
      : edit.start < range.end && edit.end > range.start
  )
}

function correctedText(
  answer: string,
  edits: ResolvedOrthographyEdit[],
): string {
  let result = ""
  let cursor = 0
  for (const edit of edits) {
    result += answer.slice(cursor, edit.start) + edit.replacement
    cursor = edit.end
  }
  return result + answer.slice(cursor)
}

function wordTokens(text: string): string[] {
  return text.match(WORD_PATTERN) ?? []
}

function appendPart(
  parts: OrthographyCorrectionPart[],
  part: OrthographyCorrectionPart,
): void {
  if (!part.changed && part.text.length === 0) return
  const previous = parts[parts.length - 1]
  if (previous && !previous.changed && !part.changed) {
    previous.text += part.text
    return
  }
  parts.push(part)
}

export function buildOrthographyCorrection(
  answer: string,
  edits: OrthographyCorrectionEdit[],
  expectedSpellingErrors: number,
  expectedPunctuationErrors: number,
): OrthographyCorrection {
  if (
    !Array.isArray(edits) ||
    !Number.isInteger(expectedSpellingErrors) ||
    !Number.isInteger(expectedPunctuationErrors) ||
    expectedSpellingErrors < 0 ||
    expectedPunctuationErrors < 0
  ) {
    throw correctionError("ungültige Eingabedaten")
  }
  const expectedTotal = expectedSpellingErrors + expectedPunctuationErrors
  if (
    expectedTotal > MAX_ORTHOGRAPHY_CORRECTION_EDITS ||
    edits.length > MAX_ORTHOGRAPHY_CORRECTION_EDITS ||
    edits.length !== expectedTotal
  ) {
    throw correctionError("die Zahl der Änderungen passt nicht zur Sprachstatistik")
  }

  const lines = answer.split("\n")
  const lineStarts: number[] = []
  let lineStart = 0
  for (const line of lines) {
    lineStarts.push(lineStart)
    lineStart += line.length + 1
  }
  const allowedKeys = new Set([
    "kind",
    "line",
    "column",
    "source",
    "replacement",
  ])
  const resolved: ResolvedOrthographyEdit[] = []
  let spellingCount = 0
  let punctuationCount = 0

  for (const candidate of edits) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).some((key) => !allowedKeys.has(key)) ||
      (candidate.kind !== "spelling" && candidate.kind !== "punctuation") ||
      !Number.isInteger(candidate.line) ||
      !Number.isInteger(candidate.column) ||
      candidate.line < 0 ||
      candidate.column < 0 ||
      typeof candidate.source !== "string" ||
      typeof candidate.replacement !== "string" ||
      codePointLength(candidate.source) > MAX_ORTHOGRAPHY_EDIT_CHARACTERS ||
      codePointLength(candidate.replacement) >
        MAX_ORTHOGRAPHY_EDIT_CHARACTERS ||
      /[\r\n\p{Cc}]/u.test(candidate.source) ||
      /[\r\n\p{Cc}]/u.test(candidate.replacement) ||
      candidate.source === candidate.replacement
    ) {
      throw correctionError("ein Änderungseintrag ist ungültig")
    }
    let resolvedLineIndex = candidate.line
    let line = lines[resolvedLineIndex]
    let absoluteLineStart = lineStarts[resolvedLineIndex]
    let columnOffset =
      line === undefined
        ? undefined
        : codePointColumnToCodeUnitOffset(line, candidate.column)
    let start =
      absoluteLineStart === undefined || columnOffset === undefined
        ? -1
        : absoluteLineStart + columnOffset
    let end = start + candidate.source.length
    const suppliedAnchorMatches =
      line !== undefined &&
      columnOffset !== undefined &&
      columnOffset + candidate.source.length <= line.length &&
      answer.slice(start, end) === candidate.source

    if (!suppliedAnchorMatches && candidate.source.length > 0) {
      const uniqueOffset = answer.indexOf(candidate.source)
      if (
        uniqueOffset >= 0 &&
        answer.indexOf(candidate.source, uniqueOffset + 1) < 0
      ) {
        for (let index = 0; index < lineStarts.length; index += 1) {
          const candidateLineStart = lineStarts[index]!
          const next = lineStarts[index + 1] ?? answer.length + 1
          if (uniqueOffset >= candidateLineStart && uniqueOffset < next) {
            resolvedLineIndex = index
            line = lines[index]
            absoluteLineStart = candidateLineStart
            columnOffset = uniqueOffset - candidateLineStart
            start = uniqueOffset
            end = start + candidate.source.length
            break
          }
        }
      }
    }
    if (line === undefined || absoluteLineStart === undefined) {
      throw correctionError("eine Zeilenposition liegt außerhalb der Antwort")
    }
    if (columnOffset === undefined) {
      throw correctionError("eine Spaltenposition liegt außerhalb der Antwort")
    }
    if (
      columnOffset + candidate.source.length > line.length ||
      answer.slice(start, end) !== candidate.source
    ) {
      throw correctionError("ein Quelltext stimmt nicht mit der Antwort überein")
    }
    const edit: ResolvedOrthographyEdit = {
      ...candidate,
      line: resolvedLineIndex,
      column: codePointLength(line.slice(0, columnOffset)),
      start,
      end,
    }
    const previous = resolved[resolved.length - 1]
    if (
      previous &&
      (edit.start < previous.start ||
        edit.start < previous.end ||
        edit.start === previous.start)
    ) {
      throw correctionError("Änderungen sind nicht sortiert oder überlappen")
    }
    if (edit.kind === "spelling") {
      spellingCount += 1
      validateSpellingEdit(answer, edit)
    } else {
      punctuationCount += 1
      validatePunctuationEdit(answer, edit)
    }
    resolved.push(edit)
  }

  if (
    spellingCount !== expectedSpellingErrors ||
    punctuationCount !== expectedPunctuationErrors
  ) {
    throw correctionError("Änderungskategorien passen nicht zur Sprachstatistik")
  }
  const ranges = protectedRanges(answer)
  if (resolved.some((edit) => editTouchesProtectedRange(edit, ranges))) {
    throw correctionError("eine Änderung betrifft geschützte Notation")
  }

  const punctuationOnly = resolved.filter(
    (edit) => edit.kind === "punctuation",
  )
  if (punctuationOnly.length > 0) {
    const withoutSpelling = correctedText(answer, punctuationOnly)
    if (
      JSON.stringify(wordTokens(withoutSpelling)) !==
      JSON.stringify(wordTokens(answer))
    ) {
      throw correctionError("eine Zeichensetzungsänderung verändert Wörter")
    }
  }

  const parts: OrthographyCorrectionPart[] = []
  let cursor = 0
  for (const edit of resolved) {
    appendPart(parts, {
      text: answer.slice(cursor, edit.start),
      changed: false,
    })
    appendPart(parts, {
      text: edit.replacement,
      changed: true,
      kind: edit.kind,
      ...(edit.source ? { removedText: edit.source } : {}),
    })
    cursor = edit.end
  }
  appendPart(parts, { text: answer.slice(cursor), changed: false })
  if (parts.length === 0) parts.push({ text: answer, changed: false })
  return { parts }
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
