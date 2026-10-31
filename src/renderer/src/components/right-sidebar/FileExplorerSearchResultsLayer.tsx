import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SearchResultsPane } from './SearchResultsPane'
import type { FileSearchPanelModel } from './useFileSearchPanel'

export function FileExplorerSearchResultsLayer({
  explorerView,
  searchPanel
}: {
  explorerView: 'files' | 'search'
  searchPanel: FileSearchPanelModel
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'absolute inset-0 flex min-h-0 flex-col',
        explorerView !== 'search' && 'pointer-events-none invisible'
      )}
    >
      {searchPanel.activeWorktreeId ? (
        <SearchResultsPane {...searchPanel.resultsProps} />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.Search.98c8435e36',
            'Select a workspace to search'
          )}
        </div>
      )}
    </div>
  )
}
