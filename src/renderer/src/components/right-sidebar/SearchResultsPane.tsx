import React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  SearchFileResult,
  SearchMatch,
  SearchResult
} from '../../../../shared/code-search-types'
import type { SearchRow } from './search-rows'
import { FileResultRow, MatchResultRow } from './SearchResultItems'
import { translate } from '@/i18n/i18n'

const SEARCH_VIRTUAL_OVERSCAN = 12

type SearchResultsPaneProps = {
  results: SearchResult | null
  error?: string | null
  hasCommittedResults: boolean
  query: string
  loading: boolean
  rows: SearchRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  onToggleCollapsedFile: (filePath: string) => void
  onMatchClick: (fileResult: SearchFileResult, match: SearchMatch) => void
}

function formatSearchResultSummary(matchCount: number, fileCount: number): string {
  const results =
    matchCount === 1
      ? translate('auto.components.right.sidebar.Search.resultCount_one', '{{count}} result', {
          count: matchCount
        })
      : translate('auto.components.right.sidebar.Search.resultCount_other', '{{count}} results', {
          count: matchCount
        })
  const files =
    fileCount === 1
      ? translate('auto.components.right.sidebar.Search.fileCount_one', '{{count}} file', {
          count: fileCount
        })
      : translate('auto.components.right.sidebar.Search.fileCount_other', '{{count}} files', {
          count: fileCount
        })
  return translate(
    'auto.components.right.sidebar.Search.resultsInFiles',
    '{{results}} in {{files}}',
    {
      results,
      files
    }
  )
}

export function SearchResultsPane({
  results,
  hasCommittedResults,
  error,
  query,
  loading,
  rows,
  scrollRef,
  onToggleCollapsedFile,
  onMatchClick
}: SearchResultsPaneProps): React.JSX.Element {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row) {
        return 20
      }
      // File rows include 6px inter-group spacing and need a taller estimate.
      if (row.type === 'file') {
        return 28
      }
      return 20
    },
    // File rows already supply top spacing; pad only the end of the list.
    paddingEnd: 8,
    overscan: SEARCH_VIRTUAL_OVERSCAN,
    getItemKey: (index) => {
      const row = rows[index]
      if (!row) {
        return `missing:${index}`
      }
      if (row.type === 'file') {
        return `file:${row.fileResult.filePath}`
      }
      return `match:${row.fileResult.filePath}:${row.match.line}:${row.match.column}:${row.matchIndex}`
    }
  })

  return (
    <>
      {!error && results && (rows.length > 0 || results.truncated) && (
        <div className="px-2 py-1 text-2xs text-muted-foreground border-b border-border">
          {formatSearchResultSummary(results.totalMatches, results.files.length)}{' '}
          {results.truncated &&
            translate('auto.components.right.sidebar.Search.dcc294f28d', '(results truncated)')}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-sleek">
        {error && (
          <div
            role="alert"
            className="p-2 text-xs text-destructive whitespace-pre-wrap break-words"
          >
            {error}
          </div>
        )}
        {!error && rows.length > 0 && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (!row) {
                return null
              }

              return (
                <div
                  key={virtualRow.key}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.type === 'file' && (
                    <FileResultRow
                      fileResult={row.fileResult}
                      collapsed={row.collapsed}
                      onToggleCollapse={() => onToggleCollapsedFile(row.fileResult.filePath)}
                    />
                  )}
                  {row.type === 'match' && (
                    <MatchResultRow
                      match={row.match}
                      relativePath={row.fileResult.relativePath}
                      onClick={() => onMatchClick(row.fileResult, row.match)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {!error && !hasCommittedResults && query && !loading && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            {translate('auto.components.right.sidebar.Search.d56d140747', 'Press Enter to search')}
          </div>
        )}

        {!error && hasCommittedResults && results?.totalMatches === 0 && !loading && (
          <div className="px-3 py-6 text-xs text-muted-foreground">
            {translate(
              'fileSearch.noResults',
              'No results. Try another search or adjust your filters.'
            )}
          </div>
        )}

        {!error && !query && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            {translate(
              'auto.components.right.sidebar.Search.1abfb25a66',
              'Type to search in files'
            )}
          </div>
        )}
      </div>
    </>
  )
}
