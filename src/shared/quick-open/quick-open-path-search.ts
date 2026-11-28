import {
  filenameContainsSeparatorVariant,
  matchQuickOpenSeparatorAlternatives
} from './quick-open-separator-match'
import { isClipboardTextByteLengthOverLimit } from '../clipboard/clipboard-text'
import { compareFileNames } from '../file-listing/file-name-sort'
import {
  asciiIdentifierBoundaries,
  unicodeIdentifierBoundaries
} from './quick-open-identifier-boundaries'

export const QUICK_OPEN_RESULT_LIMIT = 50
export const QUICK_OPEN_QUERY_MAX_BYTES = 2 * 1024
export const QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS = 256
export const QUICK_OPEN_SEARCH_VERSION = 3

export type QuickOpenIndexedFile = {
  path: string
  lowerPath: string
  lowerFilename: string
  inputIndex: number
}

export type QuickOpenSearchResult = {
  path: string
  score: number
}

export function prepareQuickOpenFiles(files: readonly string[]): QuickOpenIndexedFile[] {
  return files.map((path, inputIndex) => prepareQuickOpenFile(path, inputIndex))
}

const identifierBoundaries = new WeakMap<QuickOpenIndexedFile, ReadonlySet<number>>()

const preparedQuickOpenFiles = new WeakMap<readonly string[], QuickOpenIndexedFile[]>()

export function getPreparedQuickOpenFiles(
  files: readonly string[]
): readonly QuickOpenIndexedFile[] {
  const cached = preparedQuickOpenFiles.get(files)
  if (cached) {
    return cached
  }
  const prepared = prepareQuickOpenFiles(files)
  preparedQuickOpenFiles.set(files, prepared)
  return prepared
}

export function isQuickOpenQueryTooLarge(
  query: string,
  maxBytes = QUICK_OPEN_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function isQuickOpenRemoteQueryTooLarge(query: string): boolean {
  return query.length > QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS || isQuickOpenQueryTooLarge(query)
}

// Typing extends a query, and every term match is a greedy prefix walk, so a longer term can only
// match a subset of a shorter term's files. Rescore just those instead of the whole listing.
const lastMatches = new WeakMap<
  readonly QuickOpenIndexedFile[],
  { terms: readonly QuickOpenQueryTerm[]; matches: readonly QuickOpenIndexedFile[] }
>()

export function rankQuickOpenFiles(
  query: string,
  files: readonly QuickOpenIndexedFile[],
  limit = QUICK_OPEN_RESULT_LIMIT
): QuickOpenSearchResult[] {
  if (limit <= 0 || isQuickOpenQueryTooLarge(query)) {
    return []
  }

  const normalizedQuery = normalizeQuickOpenQuery(query)
  const previous = lastMatches.get(files)
  const candidates =
    previous && narrowsQuickOpenQuery(previous.terms, normalizedQuery) ? previous.matches : files
  const results: QuickOpenRankedResult[] = []
  const matches: QuickOpenIndexedFile[] = []
  for (const file of candidates) {
    const score = scoreQuickOpenTerms(normalizedQuery, file)
    if (score !== null) {
      matches.push(file)
      // A full heap keeps only better scores; skip building a candidate it would drop.
      if (results.length < limit || score <= results[0].score) {
        retainTopResult(results, { path: file.path, score, inputIndex: file.inputIndex }, limit)
      }
    }
  }
  lastMatches.set(files, { terms: normalizedQuery, matches })
  return finalizeResults(results)
}

/** True when every earlier term is a prefix of some new term, so new matches are a subset. */
function narrowsQuickOpenQuery(
  previous: readonly QuickOpenQueryTerm[],
  next: readonly QuickOpenQueryTerm[]
): boolean {
  return previous.every(({ text }) => next.some((term) => term.text.startsWith(text)))
}

export class QuickOpenPathRanker {
  private readonly normalizedQuery: readonly QuickOpenQueryTerm[] | null
  private readonly retained: QuickOpenRankedResult[] = []
  private inputIndex = 0
  private matchCount = 0

  constructor(
    query: string,
    private readonly limit: number
  ) {
    this.normalizedQuery =
      limit <= 0 || isQuickOpenQueryTooLarge(query) ? null : normalizeQuickOpenQuery(query)
  }

  consider(path: string): void {
    const file = prepareQuickOpenFile(path, this.inputIndex++)
    if (this.normalizedQuery === null) {
      return
    }
    const score = scoreQuickOpenTerms(this.normalizedQuery, file)
    if (score === null) {
      return
    }
    this.matchCount++
    retainTopResult(
      this.retained,
      { path: file.path, score, inputIndex: file.inputIndex },
      this.limit
    )
  }

  result(): { paths: string[]; totalCount: number } {
    return {
      paths: finalizeResults(this.retained).map((result) => result.path),
      totalCount: this.matchCount
    }
  }
}

type QuickOpenQueryTerm = { text: string; withoutSeparators: string | undefined }

const NON_ASCII = /[\u0080-\u{10ffff}]/u

// Why: macOS often stores names decomposed (NFD) while keyboards type composed (NFC); recompose after
// lowercasing too, since case mapping can leave a sequence decomposed (J\u030c → j\u030c, not ǰ).
export function composeQuickOpenText(text: string): string {
  return NON_ASCII.test(text) ? text.normalize('NFC') : text
}

function normalizeQuickOpenQuery(query: string): readonly QuickOpenQueryTerm[] {
  const lowerQuery = composeQuickOpenText(query.trim().replace(/\\/g, '/').toLowerCase())
  const terms = [...new Set(lowerQuery.split(/\s+/))].filter(Boolean).sort()
  return terms.map((text) => ({
    text,
    withoutSeparators:
      text.includes('-') || text.includes('_') ? text.replace(/[-_]/g, '') : undefined
  }))
}

function scoreQuickOpenTerms(
  terms: readonly QuickOpenQueryTerm[],
  file: QuickOpenIndexedFile
): number | null {
  let score = 0
  for (const { text: term, withoutSeparators } of terms) {
    let termScore = fuzzyMatchIndexedFile(term, file)
    if (termScore === null && withoutSeparators !== undefined) {
      const filenameStart = file.lowerPath.lastIndexOf('/', file.lowerPath.length - 2) + 1
      const parentStart = file.lowerPath.lastIndexOf('/', filenameStart - 2) + 1
      const fallback =
        fuzzyMatchIndexedFile(term, file, withoutSeparators) ??
        fuzzyMatchIndexedFile(term, file, withoutSeparators, filenameStart) ??
        fuzzyMatchIndexedFile(term, file, withoutSeparators, parentStart) ??
        (fuzzyMatchIndexedFile(withoutSeparators, file) === null
          ? null
          : matchQuickOpenSeparatorAlternatives(
              term,
              file.lowerPath,
              identifierBoundaries.get(file)
            ))
      termScore = fallback === null ? null : fallback + 10
    }
    if (termScore === null) {
      return null
    }
    score += termScore
  }
  return score
}

function prepareQuickOpenFile(path: string, inputIndex: number): QuickOpenIndexedFile {
  // Listings run this per path on every open; ASCII paths (nearly all) skip Unicode work.
  const ascii = !NON_ASCII.test(path)
  const slashed = path.includes('\\') ? path.replace(/\\/g, '/') : path
  const searchPath = ascii ? slashed : composeQuickOpenText(slashed)
  const lowerPath = ascii
    ? searchPath.toLowerCase()
    : composeQuickOpenText(searchPath.toLowerCase())
  // A folder ends in `/`; its name is the segment before it.
  const nameEnd = lowerPath.endsWith('/') ? lowerPath.length - 1 : lowerPath.length
  const file = {
    path,
    lowerPath,
    lowerFilename: lowerPath.slice(lowerPath.lastIndexOf('/', nameEnd - 1) + 1, nameEnd),
    inputIndex
  }
  if (/[A-Z]/.test(searchPath)) {
    const boundaries = ascii
      ? asciiIdentifierBoundaries(searchPath)
      : unicodeIdentifierBoundaries(searchPath)
    if (boundaries) {
      identifierBoundaries.set(file, boundaries)
    }
  }
  return file
}

function fuzzyMatchIndexedFile(
  query: string,
  file: QuickOpenIndexedFile,
  queryWithoutSeparators?: string,
  searchStart = 0
): number | null {
  const equivalentSeparators = queryWithoutSeparators !== undefined
  const { lowerPath } = file
  let qi = 0
  let score = 0
  let lastMatchIdx = -1

  while (qi < query.length) {
    const next = lastMatchIdx === -1 ? searchStart : lastMatchIdx + 1
    let ti = lowerPath.indexOf(query[qi], next)
    if (equivalentSeparators && (query[qi] === '-' || query[qi] === '_')) {
      for (const separator of ['-', '_', ' ']) {
        const alternate = lowerPath.indexOf(separator, next)
        if (alternate !== -1 && (ti === -1 || alternate < ti)) {
          ti = alternate
        }
      }
      if (lastMatchIdx >= 0 && ti !== next && identifierBoundaries.get(file)?.has(next)) {
        score += 2
        qi++
        continue
      }
    }
    if (ti === -1) {
      return null
    }
    const gap = lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
    score += gap
    // `/`, `.`, `-`, or `_` when separators are equivalent, start a word.
    const before = ti > 0 ? lowerPath.charCodeAt(ti - 1) : 0
    if (
      before === 47 ||
      before === 46 ||
      before === 45 ||
      (equivalentSeparators && before === 95)
    ) {
      score -= 5
    }
    lastMatchIdx = ti
    qi++
  }

  if (
    equivalentSeparators
      ? filenameContainsSeparatorVariant(file.lowerFilename, query) ||
        file.lowerFilename.includes(queryWithoutSeparators ?? query)
      : file.lowerFilename.includes(query)
  ) {
    score -= 100
  }
  return score
}

type QuickOpenRankedResult = QuickOpenSearchResult & {
  inputIndex: number
}

function retainTopResult(
  heap: QuickOpenRankedResult[],
  candidate: QuickOpenRankedResult,
  limit: number
): void {
  if (heap.length === limit && compareRankedResult(candidate, heap[0]) >= 0) {
    return
  }
  if (heap.length < limit) {
    heap.push(candidate)
    siftResultUp(heap, heap.length - 1)
    return
  }
  heap[0] = candidate
  siftResultDown(heap)
}

function siftResultUp(heap: QuickOpenRankedResult[], startIndex: number): void {
  let index = startIndex
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2)
    if (compareRankedResult(heap[index], heap[parentIndex]) <= 0) {
      return
    }
    ;[heap[index], heap[parentIndex]] = [heap[parentIndex], heap[index]]
    index = parentIndex
  }
}

function siftResultDown(heap: QuickOpenRankedResult[]): void {
  let index = 0
  while (true) {
    const leftIndex = index * 2 + 1
    if (leftIndex >= heap.length) {
      return
    }
    const rightIndex = leftIndex + 1
    const worseChildIndex =
      rightIndex < heap.length && compareRankedResult(heap[rightIndex], heap[leftIndex]) > 0
        ? rightIndex
        : leftIndex
    if (compareRankedResult(heap[worseChildIndex], heap[index]) <= 0) {
      return
    }
    ;[heap[index], heap[worseChildIndex]] = [heap[worseChildIndex], heap[index]]
    index = worseChildIndex
  }
}

function finalizeResults(results: QuickOpenRankedResult[]): QuickOpenSearchResult[] {
  return results
    .sort(compareRankedResult)
    .map(({ path, score }): QuickOpenSearchResult => ({ path, score }))
}

function compareRankedResult(a: QuickOpenRankedResult, b: QuickOpenRankedResult): number {
  return a.score - b.score || compareFileNames(a.path, b.path) || a.inputIndex - b.inputIndex
}
