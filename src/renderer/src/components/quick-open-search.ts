import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import { compareFileNames } from '../../../shared/file-name-sort'

export const QUICK_OPEN_RESULT_LIMIT = 50
export const QUICK_OPEN_QUERY_MAX_BYTES = 2 * 1024

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
  return files.map((path, inputIndex) => {
    const searchPath = path.replace(/\\/g, '/')
    const lastSlash = searchPath.lastIndexOf('/')
    return {
      path,
      lowerPath: searchPath.toLowerCase(),
      lowerFilename: searchPath.slice(lastSlash + 1).toLowerCase(),
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
  // still naturally type backslashes in path queries.
  const normalizedQuery = query.trim().replace(/\\/g, '/').toLowerCase()
  if (!normalizedQuery) {
    const results: QuickOpenRankedResult[] = []
    for (const file of files) {
      retainTopResult(results, { path: file.path, score: 0, inputIndex: file.inputIndex }, limit)
    }
    return finalizeResults(results)
  }

  const results: QuickOpenRankedResult[] = []
  for (const file of files) {
    const score = fuzzyMatchIndexedFile(normalizedQuery, file)
    if (score === -1) {
      continue
    }

    retainTopResult(results, { path: file.path, score, inputIndex: file.inputIndex }, limit)
  }

  return finalizeResults(results)
}

function fuzzyMatchIndexedFile(query: string, file: QuickOpenIndexedFile): number {
  let qi = 0
  let score = 0
  let lastMatchIdx = -1

  for (let ti = 0; ti < file.lowerPath.length && qi < query.length; ti++) {
    if (file.lowerPath[ti] === query[qi]) {
      // Preserve the existing Quick Open score semantics while avoiding
      // repeated lowercase work for each candidate on every keystroke.
      const gap = lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
      score += gap
      if (
        ti > 0 &&
        (file.lowerPath[ti - 1] === '/' ||
          file.lowerPath[ti - 1] === '.' ||
          file.lowerPath[ti - 1] === '-')
      ) {
        score -= 5
      }
      lastMatchIdx = ti
      qi++
    }
  }

  if (qi < query.length) {
    return -1
  }

  if (file.lowerFilename.includes(query)) {
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
