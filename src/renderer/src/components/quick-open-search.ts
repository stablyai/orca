import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'

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
    return files.slice(0, limit).map((file) => ({ path: file.path, score: 0 }))
  }

  const results: QuickOpenRankedResult[] = []
  for (const file of files) {
    const score = fuzzyMatchIndexedFile(normalizedQuery, file)
    if (score === -1) {
      continue
    }

    insertTopResult(results, { path: file.path, score, inputIndex: file.inputIndex }, limit)
  }

  return results.map(({ path, score }) => ({ path, score }))
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

function insertTopResult(
  results: QuickOpenRankedResult[],
  candidate: QuickOpenRankedResult,
  limit: number
): void {
  const worst = results.at(-1)
  if (results.length === limit && worst && compareRankedResult(candidate, worst) >= 0) {
    return
  }

  const insertAt = findInsertionIndex(results, candidate)
  results.splice(insertAt, 0, candidate)
  if (results.length > limit) {
    results.pop()
  }
}

function findInsertionIndex(
  results: readonly QuickOpenRankedResult[],
  candidate: QuickOpenRankedResult
): number {
  let low = 0
  let high = results.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (compareRankedResult(candidate, results[mid]) < 0) {
      high = mid
    } else {
      low = mid + 1
    }
  }

  return low
}

function compareRankedResult(a: QuickOpenRankedResult, b: QuickOpenRankedResult): number {
  return a.score - b.score || a.inputIndex - b.inputIndex
}
