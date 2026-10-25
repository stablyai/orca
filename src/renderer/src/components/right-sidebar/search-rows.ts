import type {
  SearchFileResult,
  SearchMatch,
  SearchResult
} from '../../../../shared/code-search-types'

export type SearchRow =
  | {
      type: 'file'
      fileResult: SearchFileResult
      collapsed: boolean
    }
  | {
      type: 'match'
      fileResult: SearchFileResult
      match: SearchMatch
      matchIndex: number
    }

export function buildSearchRows(
  results: SearchResult | null,
  collapsedFiles: ReadonlySet<string>
): SearchRow[] {
  if (!results) {
    return []
  }

  // Keep the summary outside virtualization as a fixed header while results scroll.
  const rows: SearchRow[] = []

  for (const fileResult of results.files) {
    const collapsed = collapsedFiles.has(fileResult.filePath)
    rows.push({ type: 'file', fileResult, collapsed })

    // Flatten for virtualization; mounting every ripgrep match at once froze the renderer.
    if (collapsed) {
      continue
    }

    for (const [matchIndex, match] of fileResult.matches.entries()) {
      rows.push({
        type: 'match',
        fileResult,
        match,
        matchIndex
      })
    }
  }

  return rows
}
