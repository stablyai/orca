import type { SearchFileResult, SearchMatch, SearchResult } from '../../../../shared/types'

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

  // Why: the summary row is rendered as a fixed header in Search.tsx so it
  // stays visible while the user scrolls through results and doesn't
  // participate in virtualisation.
  const rows: SearchRow[] = []

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
