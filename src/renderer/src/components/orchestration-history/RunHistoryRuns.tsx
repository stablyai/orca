import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VirtualizedList } from '@/components/virtualized-list'
import { translate } from '@/i18n/i18n'
import type { HistoryRun } from './run-history-client'
import type { HistoryPages } from './use-run-history-pages'
import { RunHistoryFeedback } from './RunHistoryFeedback'
import { runHistoryTime } from './run-history-presentation'

export function RunHistoryRuns({
  page,
  onChoose,
  onRefresh,
  onRetry,
  onLoadMore
}: {
  page: HistoryPages<HistoryRun>
  onChoose: (run: HistoryRun) => void
  onRefresh: () => void
  onRetry: () => void
  onLoadMore: () => void
}) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const refresh = () => {
    if (scrollElement) {
      scrollElement.scrollTop = 0
    }
    onRefresh()
  }
  return (
    <section aria-busy={page.loading} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">{translate('orchestrationHistory.runs', 'Runs')}</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={page.loading}
              onClick={refresh}
              aria-label={translate('orchestrationHistory.refresh', 'Refresh')}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('orchestrationHistory.refresh', 'Refresh')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div ref={setScrollElement} className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <VirtualizedList
          rows={page.rows}
          getRowKey={(run) => run.id}
          scrollElement={scrollElement}
          estimateRowHeightPx={84}
          announceListPosition
          hasUnloadedRows={page.nextCursor !== null}
          renderRow={(run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onChoose(run)}
              className="block w-full space-y-1 border-b border-border px-4 py-3 text-left hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="line-clamp-2 break-words text-sm font-medium">{run.objective}</span>
              <span className="block break-all font-mono text-xs text-muted-foreground">
                {run.id}
              </span>
              <time dateTime={run.created_at} className="block text-xs text-muted-foreground">
                {runHistoryTime(run.created_at)}
              </time>
            </button>
          )}
        />
        {!page.loading && !page.error && page.rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {translate('orchestrationHistory.noRuns', 'No runs were found on this host.')}
          </p>
        ) : null}
        <RunHistoryFeedback
          loadingVisible={page.loadingVisible}
          error={page.error}
          onRetry={onRetry}
          onRefresh={refresh}
        />
        {page.nextCursor && !page.error ? (
          <div className="p-4">
            <Button variant="outline" size="sm" disabled={page.loading} onClick={onLoadMore}>
              {translate('orchestrationHistory.loadMoreRuns', 'Load more runs')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
