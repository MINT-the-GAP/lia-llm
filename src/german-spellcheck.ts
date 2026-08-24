import { decodeFile, type ITrie, type SuggestionResult } from "cspell-trie-lib"

import { runtimeAssetUrl } from "./evaluator.ts"
import type { OrthographyCorrectionEdit } from "./types.ts"

export const GERMAN_DICTIONARY_ASSET = {
  filename: "German_de_DE.d94b8665.trie.gz",
  byteLength: 797_484,
  sha256: "d94b8665b1ae89025c564338baa424f76132788dc75935bc9775a190e2ffda3f",
} as const
const GERMAN_DICTIONARY_PINNED_FALLBACK_URL =
  "https://cdn.jsdelivr.net/npm/@cspell/dict-de-de@1.1.32/" +
  "German_de_DE.trie.gz"

const WORD_PATTERN =
  /[\p{L}\p{M}]+(?:['\u2019\u2010\u2011-][\p{L}\p{M}]+)*/gu
const ALL_UPPERCASE_PATTERN = /^\p{Lu}[\p{Lu}\p{M}]*$/u
const TITLE_CASE_PATTERN = /^\p{Lu}[\p{Ll}\p{M}]*$/u
const LOWERCASE_PATTERN = /^\p{Ll}[\p{Ll}\p{M}]*$/u
const MAX_LONG_UNKNOWN_WORD_LENGTH = 19
const MAX_DISCOVERED_WORDS = 24
const MAX_SUGGESTION_DISTANCE = 3
const CLEAR_COST_ADVANTAGE = 75
const MAX_AMBIGUOUS_CANDIDATES = 12

export interface GermanWordToken {
  /** Exact text from the unmodified answer. */
  source: string
  /** Zero-based line in the original answer. */
  line: number
  /** Zero-based Unicode-codepoint column in that line. */
  column: number
  /** UTF-16 offsets into the original answer. */
  start: number
  end: number
}

export interface GermanSpellingAmbiguity {
  token: GermanWordToken
  /** Valid dictionary words only, already adapted to the token's casing. */
  candidates: string[]
}

export interface GermanSpellingDiscovery {
  /** High-confidence one-word spelling replacements, ordered by source offset. */
  edits: OrthographyCorrectionEdit[]
  /** Narrow choices that need a context decision, ordered by source offset. */
  ambiguities: GermanSpellingAmbiguity[]
}

let dictionaryPromise: Promise<ITrie> | null = null

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Die Rechtschreibprüfung wurde abgebrochen.", "AbortError")
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = (): void => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

async function fetchGermanDictionary(url: string): Promise<ITrie> {
  const response = await fetch(url, { cache: "force-cache" })
  if (!response.ok) {
    throw new Error(
      "Deutsches Wörterbuch konnte nicht geladen werden (HTTP " +
        response.status +
        ").",
    )
  }
  const content = new Uint8Array(await response.arrayBuffer())
  if (content.byteLength !== GERMAN_DICTIONARY_ASSET.byteLength) {
    throw new Error("Das deutsche Wörterbuch hat eine unerwartete Dateigröße.")
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("Das deutsche Wörterbuch kann nicht sicher geprüft werden.")
  }
  const digest = bytesToHex(await crypto.subtle.digest("SHA-256", content))
  if (digest !== GERMAN_DICTIONARY_ASSET.sha256) {
    throw new Error("Die Integritätsprüfung des deutschen Wörterbuchs ist fehlgeschlagen.")
  }
  return decodeFile({ url: new URL(url), content })
}

async function loadGermanDictionary(): Promise<ITrie> {
  const urls = [
    runtimeAssetUrl(GERMAN_DICTIONARY_ASSET.filename),
    GERMAN_DICTIONARY_PINNED_FALLBACK_URL,
  ].filter((url, index, values) => values.indexOf(url) === index)
  let lastError: unknown
  for (const url of urls) {
    try {
      return await fetchGermanDictionary(url)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Das deutsche Wörterbuch konnte nicht geladen werden.")
}

function germanDictionary(signal: AbortSignal | undefined): Promise<ITrie> {
  if (!dictionaryPromise) {
    const loading = loadGermanDictionary().catch((error: unknown) => {
      if (dictionaryPromise === loading) dictionaryPromise = null
      throw error
    })
    dictionaryPromise = loading
  }
  return withAbort(dictionaryPromise, signal)
}

export function germanProtectedRanges(
  answer: string,
): Array<{ start: number; end: number }> {
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
      ranges.push({ start: match.index, end: match.index + match[0].length })
    }
  }
  return ranges
}

function tokenize(answer: string): GermanWordToken[] {
  const tokens: GermanWordToken[] = []
  let line = 0
  let lineStart = 0
  let newlineSearchStart = 0
  for (const match of answer.matchAll(WORD_PATTERN)) {
    if (match.index === undefined) continue
    const start = match.index
    let newline = answer.indexOf("\n", newlineSearchStart)
    while (newline >= 0 && newline < start) {
      line += 1
      lineStart = newline + 1
      newlineSearchStart = lineStart
      newline = answer.indexOf("\n", newlineSearchStart)
    }
    tokens.push({
      source: match[0],
      line,
      column: Array.from(answer.slice(lineStart, start)).length,
      start,
      end: start + match[0].length,
    })
  }
  return tokens
}

function touchesProtectedRange(
  token: GermanWordToken,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => token.start < range.end && token.end > range.start)
}

function normalizedLower(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("de-DE")
}

function preserveCasing(source: string, candidate: string): string {
  const normalized = candidate.normalize("NFC")
  if (ALL_UPPERCASE_PATTERN.test(source)) {
    return normalized.toLocaleUpperCase("de-DE")
  }
  if (TITLE_CASE_PATTERN.test(source)) {
    const lower = normalized.toLocaleLowerCase("de-DE")
    const points = Array.from(lower)
    const first = points.shift()
    return first === undefined
      ? lower
      : first.toLocaleUpperCase("de-DE") + points.join("")
  }
  if (LOWERCASE_PATTERN.test(source)) {
    return normalized.toLocaleLowerCase("de-DE")
  }
  return normalized
}

function damerauLevenshtein(left: string, right: string): number {
  const source = Array.from(normalizedLower(left))
  const target = Array.from(normalizedLower(right))
  const matrix = Array.from({ length: source.length + 1 }, () =>
    Array<number>(target.length + 1).fill(0)
  )
  for (let row = 0; row <= source.length; row += 1) matrix[row]![0] = row
  for (let column = 0; column <= target.length; column += 1) {
    matrix[0]![column] = column
  }
  for (let row = 1; row <= source.length; row += 1) {
    for (let column = 1; column <= target.length; column += 1) {
      const substitution = source[row - 1] === target[column - 1] ? 0 : 1
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + substitution,
      )
      if (
        row > 1 &&
        column > 1 &&
        source[row - 1] === target[column - 2] &&
        source[row - 2] === target[column - 1]
      ) {
        matrix[row]![column] = Math.min(
          matrix[row]![column]!,
          matrix[row - 2]![column - 2]! + 1,
        )
      }
    }
  }
  return matrix[source.length]![target.length]!
}

function sharpSCandidates(source: string, trie: ITrie): string[] {
  const positions: number[] = []
  for (
    let offset = source.indexOf("ss");
    offset >= 0;
    offset = source.indexOf("ss", offset + 2)
  ) {
    positions.push(offset)
    if (positions.length === 4) break
  }
  if (positions.length === 0) return []
  const candidates = new Set<string>()
  const variants = 1 << positions.length
  for (let mask = 1; mask < variants; mask += 1) {
    let result = ""
    let cursor = 0
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index]!
      result += source.slice(cursor, position)
      result += mask & (1 << index) ? "ß" : "ss"
      cursor = position + 2
    }
    result += source.slice(cursor)
    const cased = preserveCasing(source, result)
    if (cased !== source && trie.hasWord(normalizedLower(cased), false)) {
      candidates.add(cased)
    }
  }
  return [...candidates]
}

function dictionaryCandidates(source: string, trie: ITrie): SuggestionResult[] {
  const suggestions = trie.suggestWithCost(source.normalize("NFC"), {
    changeLimit: MAX_SUGGESTION_DISTANCE,
    ignoreCase: true,
    includeTies: true,
    numSuggestions: 16,
    timeout: 100,
  })
  const byWord = new Map<string, SuggestionResult>()
  for (const suggestion of suggestions) {
    const word = preserveCasing(source, suggestion.word)
    if (
      word === source ||
      damerauLevenshtein(source, word) > MAX_SUGGESTION_DISTANCE ||
      !trie.hasWord(normalizedLower(word), false)
    ) {
      continue
    }
    const existing = byWord.get(word)
    if (!existing || suggestion.cost < existing.cost) {
      byWord.set(word, { ...suggestion, word })
    }
  }
  return [...byWord.values()].sort(
    (left, right) =>
      left.cost - right.cost || left.word.localeCompare(right.word, "de"),
  )
}

function spellingEdit(
  token: GermanWordToken,
  replacement: string,
): OrthographyCorrectionEdit {
  return {
    kind: "spelling",
    line: token.line,
    column: token.column,
    source: token.source,
    replacement,
  }
}

/**
 * Lazily loads the bundled de-DE trie and discovers conservative one-word
 * spelling fixes. It deliberately does not inspect grammar or punctuation.
 */
export async function discoverGermanSpelling(
  answer: string,
  signal?: AbortSignal,
): Promise<GermanSpellingDiscovery> {
  throwIfAborted(signal)
  const trie = await germanDictionary(signal)
  throwIfAborted(signal)
  const ranges = germanProtectedRanges(answer)
  const edits: OrthographyCorrectionEdit[] = []
  const ambiguities: GermanSpellingAmbiguity[] = []

  for (const token of tokenize(answer)) {
    throwIfAborted(signal)
    if (edits.length + ambiguities.length >= MAX_DISCOVERED_WORDS) break
    if (touchesProtectedRange(token, ranges)) continue
    if (ALL_UPPERCASE_PATTERN.test(token.source) && token.source.length > 1) continue
    const source = token.source.normalize("NFC")
    if (trie.hasWord(normalizedLower(source), false)) continue

    const sharpS = sharpSCandidates(token.source, trie)
    if (sharpS.length === 1) {
      edits.push(spellingEdit(token, sharpS[0]!))
      continue
    }
    if (sharpS.length > 1) {
      ambiguities.push({ token, candidates: sharpS })
      continue
    }

    // Long unknown words are commonly valid German compounds, names, or
    // subject-specific terms. Do not replace them based on a fuzzy near-match.
    if (Array.from(source).length > MAX_LONG_UNKNOWN_WORD_LENGTH) continue
    const suggestions = dictionaryCandidates(token.source, trie)
    if (suggestions.length === 0) continue
    const bestCost = suggestions[0]!.cost
    const best = suggestions.filter((candidate) => candidate.cost === bestCost)
    const nextCost = suggestions.find((candidate) => candidate.cost > bestCost)?.cost
    if (
      best.length === 1 &&
      (nextCost === undefined || nextCost - bestCost >= CLEAR_COST_ADVANTAGE)
    ) {
      edits.push(spellingEdit(token, best[0]!.word))
      continue
    }
    const candidates = suggestions
      .filter((candidate) => candidate.cost <= bestCost + 100)
      .slice(0, MAX_AMBIGUOUS_CANDIDATES)
      .map((candidate) => candidate.word)
    if (candidates.length > 0) ambiguities.push({ token, candidates })
  }

  return { edits, ambiguities }
}
