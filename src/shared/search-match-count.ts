import type { SearchFileResult, SearchResult } from './types'

function isValidMatchCount(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  )
}

export function normalizeSearchFileMatchCount(
  fileResult: Pick<SearchFileResult, 'matches' | 'matchCount'>
): number {
  const matchCount = isValidMatchCount(fileResult.matchCount) ? fileResult.matchCount : 0
  return Math.max(matchCount, fileResult.matches.length)
}

export function normalizeSearchFileResult(fileResult: SearchFileResult): SearchFileResult {
  return {
    ...fileResult,
    matchCount: normalizeSearchFileMatchCount(fileResult)
  }
}

export function normalizeSearchResult(result: SearchResult): SearchResult {
  return {
    ...result,
    files: result.files
      .filter((fileResult) => fileResult.matches.length > 0)
      .map(normalizeSearchFileResult)
  }
}
