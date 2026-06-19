import React from 'react'
import { translate } from '@/i18n/i18n'
import type { RightSidebarExplorerView } from '../../../../shared/types'
import { FileExplorerQueryStrip } from './FileExplorerQueryStrip'
import { SearchFilters } from './SearchFilters'
import { SearchQueryRow } from './SearchQueryRow'
import { SearchResultsPane } from './SearchResultsPane'
import { useFileSearchPanel } from './useFileSearchPanel'

type SearchProps = {
  explorerView: RightSidebarExplorerView
  onSelectExplorerView: (view: RightSidebarExplorerView) => void
}

export default function Search({
  explorerView,
  onSelectExplorerView
}: SearchProps): React.JSX.Element {
  const searchPanel = useFileSearchPanel(explorerView)

  if (!searchPanel.activeWorktreeId) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.Search.98c8435e36',
          'Select a workspace to search'
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <FileExplorerQueryStrip view={explorerView} onSelectView={onSelectExplorerView}>
        <SearchQueryRow {...searchPanel.queryRowProps} />
      </FileExplorerQueryStrip>
      <div className="border-b border-border px-2 pb-1.5">
        <SearchFilters {...searchPanel.filtersProps} />
      </div>
      <SearchResultsPane {...searchPanel.resultsProps} />
    </div>
  )
}
