import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import { compareFileNames } from '../../../shared/file-name-sort'
import { fuzzyMatchIndexedFile, prepareQuickOpenQuery } from './quick-open-fuzzy-match'

export const QUICK_OPEN_RESULT_LIMIT = 50
export const QUICK_OPEN_QUERY_MAX_BYTES = 2 * 1024

export type QuickOpenIndexedFile = {
  path: string
  lowerPath: string
  lowerFilename: string
  /**
   * Per lowerPath index: 1 when the char is a word start (path start, after a
   * separator, or identifier transition). Built from the original-case path
   * so ProductDetail stays two words after lowercasing.
   */
  wordStarts: Uint8Array
  inputIndex: number
}

export type QuickOpenSearchResult = {
  path: string
  score: number
}

export function prepareQuickOpenFiles(files: readonly string[]): QuickOpenIndexedFile[] {
  return files.map((path, inputIndex) => {
    // Why: Quick Open presents slash-normalized paths even on Windows.
    const searchPath = path.replace(/\\/g, '/')
    const lastSlash = searchPath.lastIndexOf('/')
    const { lowerPath, wordStarts } = buildSearchPathIndex(searchPath)
    return {
      path,
      lowerPath,
      lowerFilename: searchPath.slice(lastSlash + 1).toLowerCase(),
      wordStarts,
      inputIndex
    }
  })
}

const preparedQuickOpenFiles = new WeakMap<readonly string[], QuickOpenIndexedFile[]>()

// Why: keystroke-driven callers re-classify on every character, but the index
// only changes when the file list array itself is replaced.
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

export function rankQuickOpenFiles(
  query: string,
  files: readonly QuickOpenIndexedFile[],
  limit = QUICK_OPEN_RESULT_LIMIT
): QuickOpenSearchResult[] {
  if (limit <= 0) {
    return []
  }
  if (isQuickOpenQueryTooLarge(query)) {
    return []
  }

  // Why: Quick Open presents slash-normalized paths even on Windows; users
  // still naturally type backslashes in path queries. Collapse internal
  // whitespace so "Product  Detail" behaves like "Product Detail".
  const normalizedQuery = query.trim().replace(/\\/g, '/').toLowerCase().replace(/\s+/g, ' ')
  if (!normalizedQuery) {
    const results: QuickOpenRankedResult[] = []
    for (const file of files) {
      retainTopResult(results, { path: file.path, score: 0, inputIndex: file.inputIndex }, limit)
    }
    return finalizeResults(results)
  }
  const preparedQuery = prepareQuickOpenQuery(normalizedQuery)

  const results: QuickOpenRankedResult[] = []
  for (const file of files) {
    const score = fuzzyMatchIndexedFile(preparedQuery, file)
    if (score === null) {
      continue
    }

    retainTopResult(results, { path: file.path, score, inputIndex: file.inputIndex }, limit)
  }

  return finalizeResults(results)
}

/**
 * Word starts from the original-case slash-normalized path so identifier
 * boundaries survive lowercasing in lowerPath.
 */
function buildSearchPathIndex(searchPath: string): {
  lowerPath: string
  wordStarts: Uint8Array
} {
  const lowerPath = searchPath.toLowerCase()
  const starts = new Uint8Array(lowerPath.length)
  let lowerIndex = 0
  for (let i = 0; i < searchPath.length; i++) {
    // Why: this loop touches every character in repositories that can exceed
    // 100k paths; read each code unit once instead of repeatedly decoding it.
    const currCode = searchPath.charCodeAt(i)
    const prevCode = i > 0 ? searchPath.charCodeAt(i - 1) : -1
    const nextCode = i + 1 < searchPath.length ? searchPath.charCodeAt(i + 1) : -1
    if (
      i === 0 ||
      isPathSeparatorCode(prevCode) ||
      (isAsciiLetterCode(prevCode) && isAsciiDigitCode(currCode)) ||
      (isAsciiDigitCode(prevCode) && isAsciiLetterCode(currCode)) ||
      (isAsciiLowerOrDigitCode(prevCode) && isAsciiUpperCode(currCode)) ||
      (isAsciiUpperCode(prevCode) && isAsciiUpperCode(currCode) && isAsciiLowerCode(nextCode))
    ) {
      starts[lowerIndex] = 1
    }
    // Why: Unicode lowercasing can expand one source character, so boundary
    // offsets must advance in lowerPath's coordinate space. ASCII skips the
    // per-character lowercase allocation; 100k-file indexing is ~2x faster.
    lowerIndex += currCode < 128 ? 1 : searchPath[i].toLowerCase().length
  }
  return { lowerPath, wordStarts: starts }
}

function isAsciiLowerOrDigitCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122)
}

function isAsciiDigitCode(code: number): boolean {
  return code >= 48 && code <= 57
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isAsciiUpperCode(code: number): boolean {
  return code >= 65 && code <= 90
}

function isAsciiLowerCode(code: number): boolean {
  return code >= 97 && code <= 122
}

function isPathSeparatorCode(code: number): boolean {
  return code === 47 || code === 95 || code === 45 || code === 46 || code === 32
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
