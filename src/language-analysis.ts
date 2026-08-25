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
const GRAMMAR_FORM_GROUPS: readonly (readonly string[])[] = [
  ["der", "die", "das", "den", "dem", "des"],
  ["ein", "eine", "einen", "einem", "einer", "eines"],
  ["kein", "keine", "keinen", "keinem", "keiner", "keines"],
  ["mein", "meine", "meinen", "meinem", "meiner", "meines"],
  ["dein", "deine", "deinen", "deinem", "deiner", "deines"],
  ["sein", "seine", "seinen", "seinem", "seiner", "seines"],
  ["ihr", "ihre", "ihren", "ihrem", "ihrer", "ihres"],
  ["unser", "unsere", "unseren", "unserem", "unserer", "unseres"],
  ["euer", "eure", "euren", "eurem", "eurer", "eures"],
  ["dies", "diese", "diesen", "diesem", "dieser", "dieses"],
  ["jede", "jeden", "jedem", "jeder", "jedes"],
  ["jene", "jenen", "jenem", "jener", "jenes"],
  ["welch", "welche", "welchen", "welchem", "welcher", "welches"],
  ["solch", "solche", "solchen", "solchem", "solcher", "solches"],
  ["manch", "manche", "manchen", "manchem", "mancher", "manches"],
  ["ich", "mich", "mir"],
  ["du", "dich", "dir"],
  ["er", "ihn", "ihm"],
  ["sie", "ihr"],
  ["wir", "uns"],
  ["ihr", "euch"],
  ["wer", "wen", "wem", "wessen"],
  ["bin", "bist", "ist", "sind", "seid"],
  ["habe", "hast", "hat", "haben", "habt"],
]

export interface GrammarCorrectionCandidate {
  /** Stable, zero-based identifier in source-text order. */
  candidateId: number
  /** Zero-based line in the unmodified answer. */
  line: number
  /** Zero-based Unicode-codepoint column in that line. */
  column: number
  /** Exact word from the unmodified answer. */
  source: string
  /** Locally approved forms; option 0 is always the exact original word. */
  options: string[]
}

interface GrammarWordToken {
  source: string
  line: number
  column: number
  start: number
  end: number
}

interface GrammarCandidateEntry {
  candidate: GrammarCorrectionCandidate
  token: GrammarWordToken
}

interface ResolvedOrthographyEdit extends OrthographyCorrectionEdit {
  start: number
  end: number
}

function correctionError(message: string): Error {
  return new Error("Ungültige Sprachkorrektur: " + message)
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

function grammarCaseStyle(value: string): "lower" | "title" | "upper" | null {
  const lower = value.toLocaleLowerCase("de-DE")
  if (value === lower) return "lower"
  if (value === value.toLocaleUpperCase("de-DE")) return "upper"
  const points = Array.from(lower)
  const first = points.shift()
  const title = first === undefined
    ? lower
    : first.toLocaleUpperCase("de-DE") + points.join("")
  return value === title ? "title" : null
}

function grammarFormWithCase(
  value: string,
  style: 'lower' | 'title' | 'upper',
): string {
  if (style === 'lower') return value.toLocaleLowerCase('de-DE')
  if (style === 'upper') return value.toLocaleUpperCase('de-DE')
  const lower = value.toLocaleLowerCase('de-DE')
  const points = Array.from(lower)
  const first = points.shift()
  return first === undefined
    ? lower
    : first.toLocaleUpperCase('de-DE') + points.join('')
}

function inSameGrammarFormGroup(source: string, replacement: string): boolean {
  return GRAMMAR_FORM_GROUPS.some(
    (group) => group.includes(source) && group.includes(replacement),
  )
}

function validateGrammarEdit(
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
    throw correctionError(
      "eine Grammatikänderung ist kein einzelner Wortformersatz",
    )
  }
  if (!hasWholeWordBoundaries(answer, edit.start, edit.end)) {
    throw correctionError("eine Grammatikänderung liegt nicht auf Wortgrenzen")
  }

  const sourceTokens = spellingTokens(edit.source)
  const replacementTokens = spellingTokens(edit.replacement)
  if (sourceTokens.length !== 1 || replacementTokens.length !== 1) {
    throw correctionError("eine Grammatikänderung muss genau ein Wort ersetzen")
  }

  const sourceStyle = grammarCaseStyle(edit.source.normalize("NFC"))
  const replacementStyle = grammarCaseStyle(edit.replacement.normalize("NFC"))
  if (sourceStyle === null || replacementStyle !== sourceStyle) {
    throw correctionError(
      "eine Grammatikänderung verändert die Schreibweise statt nur die Wortform",
    )
  }
  const source = edit.source.normalize("NFC").toLocaleLowerCase("de-DE")
  const replacement = edit.replacement
    .normalize("NFC")
    .toLocaleLowerCase("de-DE")
  if (
    !inSameGrammarFormGroup(source, replacement) ||
    damerauLevenshtein(source, replacement) > 3
  ) {
    throw correctionError(
      "eine Grammatikkorrektur ersetzt keine lokal freigegebene Wortform",
    )
  }
}

function delimiterRunEnd(
  text: string,
  start: number,
  delimiter: string,
): number {
  let end = start
  while (text[end] === delimiter) end += 1
  return end
}

function markdownLineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
}

function markdownLineEnd(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset)
  return newline < 0 ? text.length : newline
}

interface MarkdownFenceContainer {
  blockquoteDepth: number
  listIndentColumns?: number
}

function splitMarkdownBlockquotePrefix(
  prefix: string,
): { blockquoteDepth: number; rest: string } {
  let blockquoteDepth = 0
  let rest = prefix
  while (true) {
    const marker = /^ {0,3}>[ \t]?/u.exec(rest)
    if (marker === null) break
    blockquoteDepth += 1
    rest = rest.slice(marker[0].length)
  }
  return { blockquoteDepth, rest }
}

function markdownIndentColumns(value: string): number {
  let columns = 0
  for (const character of value) {
    columns = character === '\t'
      ? columns + (4 - columns % 4)
      : columns + 1
  }
  return columns
}

function markdownFenceContainer(
  text: string,
  start: number,
  end: number,
  delimiter: string,
): MarkdownFenceContainer | undefined {
  if (
    delimiter === '\x60' &&
    text.slice(end, markdownLineEnd(text, end)).includes('\x60')
  ) {
    return undefined
  }
  const prefix = text.slice(markdownLineStart(text, start), start)
  const { blockquoteDepth, rest } = splitMarkdownBlockquotePrefix(prefix)
  if (/^ {0,3}$/u.test(rest)) return { blockquoteDepth }

  const list = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)$/u.exec(rest)
  if (list === null) return undefined
  return {
    blockquoteDepth,
    listIndentColumns: markdownIndentColumns(
      list[1]! + list[2]! + list[3]!,
    ),
  }
}

function isMarkdownFenceCloser(
  text: string,
  start: number,
  end: number,
  container: MarkdownFenceContainer,
): boolean {
  const prefix = text.slice(markdownLineStart(text, start), start)
  const { blockquoteDepth, rest } = splitMarkdownBlockquotePrefix(prefix)
  if (blockquoteDepth !== container.blockquoteDepth) return false

  const validContainerPrefix = container.listIndentColumns === undefined
    ? /^ {0,3}$/u.test(rest)
    : /^[ \t]+$/u.test(rest) &&
      markdownIndentColumns(rest) >= container.listIndentColumns &&
      markdownIndentColumns(rest) <= container.listIndentColumns + 3
  return validContainerPrefix &&
    /^[ \t\r]*$/u.test(text.slice(end, markdownLineEnd(text, end)))
}

function markdownFenceRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < text.length) {
    const delimiter = text[cursor]
    if (delimiter !== '\x60' && delimiter !== '~') {
      cursor += 1
      continue
    }
    const openerEnd = delimiterRunEnd(text, cursor, delimiter)
    const openerLength = openerEnd - cursor
    const container = openerLength < 3
      ? undefined
      : markdownFenceContainer(text, cursor, openerEnd, delimiter)
    if (container === undefined) {
      cursor = openerEnd
      continue
    }

    let searchFrom = openerEnd
    let closingEnd: number | undefined
    while (searchFrom < text.length) {
      const closingStart = text.indexOf(delimiter, searchFrom)
      if (closingStart < 0) break
      const runEnd = delimiterRunEnd(text, closingStart, delimiter)
      if (
        runEnd - closingStart >= openerLength &&
        isMarkdownFenceCloser(text, closingStart, runEnd, container)
      ) {
        closingEnd = runEnd
        break
      }
      searchFrom = runEnd
    }
    if (closingEnd === undefined) {
      ranges.push({ start: cursor, end: text.length })
      break
    }
    ranges.push({ start: cursor, end: closingEnd })
    cursor = closingEnd
  }
  return ranges
}

function containingRange(
  offset: number,
  ranges: Array<{ start: number; end: number }>,
): { start: number; end: number } | undefined {
  return ranges.find((range) => offset >= range.start && offset < range.end)
}

function markdownInlineCodeRanges(
  text: string,
  fenceRanges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < text.length) {
    const openingStart = text.indexOf('\x60', cursor)
    if (openingStart < 0) break
    const fence = containingRange(openingStart, fenceRanges)
    if (fence !== undefined) {
      cursor = fence.end
      continue
    }
    const openingEnd = delimiterRunEnd(text, openingStart, '\x60')
    const delimiterLength = openingEnd - openingStart

    let searchFrom = openingEnd
    let closingEnd: number | undefined
    while (searchFrom < text.length) {
      const closingStart = text.indexOf('\x60', searchFrom)
      if (closingStart < 0) break
      const closingFence = containingRange(closingStart, fenceRanges)
      if (closingFence !== undefined) {
        searchFrom = closingFence.end
        continue
      }
      const runEnd = delimiterRunEnd(text, closingStart, '\x60')
      if (runEnd - closingStart === delimiterLength) {
        closingEnd = runEnd
        break
      }
      searchFrom = runEnd
    }
    if (closingEnd === undefined) {
      cursor = openingEnd
      continue
    }
    ranges.push({ start: openingStart, end: closingEnd })
    cursor = closingEnd
  }
  return ranges
}

function escapedTexRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const [opening, closing] of [
    ['\\(', '\\)'],
    ['\\[', '\\]'],
  ] as const) {
    let cursor = 0
    while (cursor < text.length) {
      const start = text.indexOf(opening, cursor)
      if (start < 0) break
      const closingStart = text.indexOf(closing, start + opening.length)
      if (closingStart < 0) break
      const end = closingStart + closing.length
      ranges.push({ start, end })
      cursor = end
    }
  }
  return ranges
}

function markdownIndentedCodeRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    const { rest } = splitMarkdownBlockquotePrefix(line)
    if (/^(?: {4,}| {0,3}\t)/u.test(rest)) {
      ranges.push({ start: lineStart, end: lineEnd })
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  return ranges
}

function htmlMarkupRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor)
    if (start < 0) break

    if (text.startsWith('<!--', start)) {
      const closingStart = text.indexOf('-->', start + 4)
      const end = closingStart < 0 ? text.length : closingStart + 3
      ranges.push({ start, end })
      if (closingStart < 0) break
      cursor = end
      continue
    }

    const tag = /^<\/?[a-z][a-z\d:-]*/iu.exec(text.slice(start))
    if (tag === null) {
      cursor = start + 1
      continue
    }

    let quote: '"' | "'" | undefined
    let scan = start + tag[0].length
    let end: number | undefined
    while (scan < text.length) {
      const character = text[scan]
      if (quote !== undefined) {
        if (character === quote) quote = undefined
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        end = scan + 1
        break
      }
      scan += 1
    }
    if (end === undefined) {
      cursor = start + 1
      continue
    }
    ranges.push({ start, end })
    cursor = end
  }
  return ranges
}

function protectedRanges(answer: string): Array<{ start: number; end: number }> {
  const fenceRanges = markdownFenceRanges(answer)
  const ranges: Array<{ start: number; end: number }> = [
    ...fenceRanges,
    ...markdownInlineCodeRanges(answer, fenceRanges),
    ...markdownIndentedCodeRanges(answer),
    ...escapedTexRanges(answer),
    ...htmlMarkupRanges(answer),
  ]
  const patterns = [
    /https?:\/\/[^\s]+|www\.[^\s]+/giu,
    /<(?:code|pre)\b[^>]*>[\s\S]*?(?:<\/(?:code|pre)\s*>|$)/giu,
    /<[^>\n]+>/gu,
    /&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/giu,
    /\$\$(?:\\[\s\S]|[^$\\])*\$\$|\$(?:\\[^\r\n]|[^$\\\r\n])+\$/gu,
    /\\[a-z]+/giu,
  ]
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

function grammarWordTokens(text: string): GrammarWordToken[] {
  const tokens: GrammarWordToken[] = []
  let line = 0
  let lineStart = 0
  let newlineSearchStart = 0
  const pattern = new RegExp(
    SPELLING_TOKEN_PATTERN.source,
    SPELLING_TOKEN_PATTERN.flags,
  )
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue
    const start = match.index
    let newline = text.indexOf('\n', newlineSearchStart)
    while (newline >= 0 && newline < start) {
      line += 1
      lineStart = newline + 1
      newlineSearchStart = lineStart
      newline = text.indexOf('\n', newlineSearchStart)
    }
    tokens.push({
      source: match[0],
      line,
      column: codePointLength(text.slice(lineStart, start)),
      start,
      end: start + match[0].length,
    })
  }
  return tokens
}

function grammarTokenTouchesProtectedRange(
  token: GrammarWordToken,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) =>
    token.start < range.end && token.end > range.start
  )
}

function grammarOptions(source: string): string[] {
  const normalized = source.normalize('NFC')
  const style = grammarCaseStyle(normalized)
  if (style === null) return []
  const lower = normalized.toLocaleLowerCase('de-DE')
  const options = [source]
  const seen = new Set(options)
  for (const group of GRAMMAR_FORM_GROUPS) {
    if (!group.includes(lower)) continue
    for (const form of group) {
      if (
        form === lower ||
        !inSameGrammarFormGroup(lower, form) ||
        damerauLevenshtein(lower, form) > 3
      ) {
        continue
      }
      const option = grammarFormWithCase(form, style)
      if (!seen.has(option)) {
        seen.add(option)
        options.push(option)
      }
    }
  }
  return options
}

function grammarCandidateEntries(answer: string): GrammarCandidateEntry[] {
  const ranges = protectedRanges(answer)
  const entries: GrammarCandidateEntry[] = []
  for (const token of grammarWordTokens(answer)) {
    if (
      !SPELLING_VALUE_PATTERN.test(token.source) ||
      codePointLength(token.source) < 2 ||
      !hasWholeWordBoundaries(answer, token.start, token.end) ||
      grammarTokenTouchesProtectedRange(token, ranges)
    ) {
      continue
    }
    const options = grammarOptions(token.source)
    if (options.length < 2) continue
    entries.push({
      candidate: {
        candidateId: entries.length,
        line: token.line,
        column: token.column,
        source: token.source,
        options,
      },
      token,
    })
  }
  return entries
}

/**
 * Enumerates every locally approved one-word grammar choice in source order.
 * Positions and option texts are derived exclusively from the original answer.
 */
export function grammarCorrectionCandidates(
  answer: string,
): GrammarCorrectionCandidate[] {
  return grammarCandidateEntries(answer).map(({ candidate }) => candidate)
}

/**
 * Uses a reference only when both texts have exactly the same word-token and
 * inter-token structure. Any differing word must be a locally approved option.
 * Undefined means the reference is not a safe structural anchor; an empty
 * array means it is safe but contains no approved word-form difference.
 */
export function referenceAnchoredGrammarEdits(
  answer: string,
  reference: string,
): OrthographyCorrectionEdit[] | undefined {
  const answerTokens = grammarWordTokens(answer)
  const referenceTokens = grammarWordTokens(reference)
  if (answerTokens.length !== referenceTokens.length) return undefined

  const candidatesByStart = new Map(
    grammarCandidateEntries(answer).map((entry) => [entry.token.start, entry]),
  )
  const edits: OrthographyCorrectionEdit[] = []
  let answerCursor = 0
  let referenceCursor = 0
  for (let index = 0; index < answerTokens.length; index += 1) {
    const answerToken = answerTokens[index]!
    const referenceToken = referenceTokens[index]!
    if (
      answer.slice(answerCursor, answerToken.start) !==
        reference.slice(referenceCursor, referenceToken.start)
    ) {
      return undefined
    }
    if (answerToken.source !== referenceToken.source) {
      const entry = candidatesByStart.get(answerToken.start)
      const optionId = entry?.candidate.options.indexOf(referenceToken.source) ??
        -1
      if (entry === undefined || optionId <= 0) return undefined
      edits.push({
        kind: 'grammar',
        line: entry.candidate.line,
        column: entry.candidate.column,
        source: entry.candidate.source,
        replacement: entry.candidate.options[optionId]!,
      })
    }
    answerCursor = answerToken.end
    referenceCursor = referenceToken.end
  }
  if (answer.slice(answerCursor) !== reference.slice(referenceCursor)) {
    return undefined
  }
  return edits
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
  expectedGrammarEdits = 0,
): OrthographyCorrection {
  if (
    !Array.isArray(edits) ||
    !Number.isInteger(expectedSpellingErrors) ||
    !Number.isInteger(expectedPunctuationErrors) ||
    !Number.isInteger(expectedGrammarEdits) ||
    expectedSpellingErrors < 0 ||
    expectedPunctuationErrors < 0 ||
    expectedGrammarEdits < 0
  ) {
    throw correctionError("ungültige Eingabedaten")
  }
  const expectedTotal =
    expectedSpellingErrors + expectedPunctuationErrors + expectedGrammarEdits
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
  let grammarCount = 0

  for (const candidate of edits) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).some((key) => !allowedKeys.has(key)) ||
      (candidate.kind !== "spelling" &&
        candidate.kind !== "punctuation" &&
        candidate.kind !== "grammar") ||
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
    } else if (edit.kind === "punctuation") {
      punctuationCount += 1
      validatePunctuationEdit(answer, edit)
    } else {
      grammarCount += 1
      validateGrammarEdit(answer, edit)
    }
    resolved.push(edit)
  }

  if (
    spellingCount !== expectedSpellingErrors ||
    punctuationCount !== expectedPunctuationErrors ||
    grammarCount !== expectedGrammarEdits
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
