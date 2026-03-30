import type { SearchFileResult, SearchMatch, SearchResult } from '../../../../shared/types'

export type SearchRow =
  | {
      type: 'summary'
      totalMatches: number
      fileCount: number
      truncated: boolean
    }
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

  const rows: SearchRow[] = [
    {
      type: 'summary',
      totalMatches: results.totalMatches,
      fileCount: results.files.length,
      truncated: results.truncated
    }
  ]

  for (const fileResult of results.files) {
    const collapsed = collapsedFiles.has(fileResult.filePath)
    rows.push({ type: 'file', fileResult, collapsed })

    // Why: flattening the tree into rows lets the sidebar virtualize search
    // output. Rendering every file header and every match at once is what made
    // large ripgrep result sets freeze the renderer.
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
