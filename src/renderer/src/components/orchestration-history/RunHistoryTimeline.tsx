import { useDeferredValue, useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VirtualizedList } from '@/components/virtualized-list'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { getTranslationResourceVersion } from '@/i18n/translation-resource-version'
import type { RunEvent } from '../../../../shared/orchestration-run-events'
import type { HistoryRun } from './run-history-client'
import type { HistoryPages } from './use-run-history-pages'
import { RunHistoryFeedback } from './RunHistoryFeedback'
import { runEventDetails, runEventLabel, runHistoryTime } from './run-history-presentation'

export type RunHistoryTimelineProps = {
  run: HistoryRun
  page: HistoryPages<RunEvent>
  onBack: () => void
  onRefresh: () => void
  onRetry: () => void
  onLoadMore: () => void
  onOpenAgent?: (event: RunEvent) => void
  openingSequence?: number | null
  openingVisible?: boolean
}

export function RunHistoryTimeline({
  run,
  page,
  onBack,
  onRefresh,
  onRetry,
  onLoadMore,
  onOpenAgent,
  openingSequence,
  openingVisible
}: RunHistoryTimelineProps) {
  const [query, setQuery] = useState('')
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const resetScroll = () => {
    if (scrollElement) {
      scrollElement.scrollTop = 0
    }
  }
  const refresh = () => {
    resetScroll()
    onRefresh()
  }
  const deferredQuery = useDeferredValue(query)
  const locale = getIntlLocale()
  const translationVersion = getTranslationResourceVersion()
  const rows = useMemo(() => {
    const titles = new Map<string, string>()
    for (const event of page.rows) {
      if (event.taskId && event.data.title) {
        titles.set(event.taskId, event.data.title)
      }
    }
    const needle = deferredQuery.trim().toLocaleLowerCase(locale)
    return page.rows
      .map((event) => ({
        // Translation changes invalidate the virtualizer's measured row heights.
        key: `${translationVersion}:${event.sequence}`,
        event,
        label: runEventLabel(event.kind),
        details: runEventDetails(event, titles)
      }))
      .filter(
        ({ event, label, details }) =>
          !needle ||
          [
            label,
            ...details.map((detail) => detail.text),
            event.entityId,
            event.taskId,
            event.dispatchId
          ]
            .filter((part) => part !== null)
            .join(' ')
            .toLocaleLowerCase(locale)
            .includes(needle)
      )
  }, [page.rows, deferredQuery, locale, translationVersion])

  return (
    <section
      aria-label={translate('orchestrationHistory.timeline', 'Recorded events')}
      aria-busy={page.loading}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-start gap-3 border-b border-border p-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {translate('orchestrationHistory.runs', 'Runs')}
        </Button>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="scrollbar-sleek max-h-32 overflow-y-auto break-words text-sm font-medium">
            {run.objective}
          </h2>
          <p className="break-all font-mono text-xs text-muted-foreground">{run.id}</p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={refresh}
              disabled={page.loading}
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
      {page.coverage ? (
        <div className="space-y-1 border-b border-border px-4 py-3 text-xs text-muted-foreground">
          <p>
            {page.coverage.completeFromCreation
              ? translate(
                  'orchestrationHistory.completeCoverage',
                  'History recorded from run creation.'
                )
              : translate(
                  'orchestrationHistory.partialCoverage',
                  'Earlier history is incomplete. Continuous recording since {{time}}.',
                  { time: runHistoryTime(page.coverage.recordedSince) }
                )}
          </p>
          <p>
            {translate(
              'orchestrationHistory.order',
              'Oldest events first. Times are shown in your local time.'
            )}
          </p>
        </div>
      ) : null}
      <div className="px-4 py-3">
        <Input
          disabled={page.rows.length === 0}
          value={query}
          onChange={(event) => {
            resetScroll()
            setQuery(event.target.value)
          }}
          aria-label={translate('orchestrationHistory.filter', 'Filter loaded events')}
          placeholder={translate('orchestrationHistory.filter', 'Filter loaded events')}
        />
      </div>
      <div ref={setScrollElement} className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <VirtualizedList
          rows={rows}
          scrollElement={scrollElement}
          estimateRowHeightPx={112}
          getRowKey={({ key }) => key}
          announceListPosition
          hasUnloadedRows={page.nextCursor !== null}
          renderRow={({ key, event, label, details }) => (
            <article key={key} className="space-y-1 border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <h3 className="min-w-0 flex-1 text-sm font-medium">{label}</h3>
                {onOpenAgent && (event.dispatchId || event.data.coordinator) ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={openingSequence != null}
                    aria-busy={openingSequence === event.sequence}
                    onClick={() => onOpenAgent(event)}
                  >
                    {openingSequence === event.sequence && openingVisible ? (
                      <LoadingSpinner className="size-3" />
                    ) : (
                      <ExternalLink aria-hidden="true" />
                    )}
                    {translate('orchestrationHistory.openAgent', 'Open agent')}
                  </Button>
                ) : null}
              </div>
              {details.map((detail) => (
                <p
                  key={detail.id}
                  className={cn(
                    'break-words text-sm',
                    detail.literal && 'break-all font-mono text-xs'
                  )}
                >
                  {detail.text}
                </p>
              ))}
              <p className="break-all font-mono text-xs text-muted-foreground">{event.entityId}</p>
              <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <time dateTime={event.recordedAt}>{runHistoryTime(event.recordedAt)}</time>
                <span>#{event.sequence}</span>
              </p>
              {event.kind.endsWith('.removed') ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'orchestrationHistory.removalNotice',
                    'Record removal does not mean that a worker stopped.'
                  )}
                </p>
              ) : null}
            </article>
          )}
        />
        {!page.loading && !page.error && rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {page.rows.length === 0
              ? translate('orchestrationHistory.noEvents', 'No recorded events.')
              : translate('orchestrationHistory.noMatches', 'No loaded events match this filter.')}
          </p>
        ) : null}
        <RunHistoryFeedback
          loadingVisible={page.loadingVisible}
          error={page.error}
          onRetry={onRetry}
          onRefresh={refresh}
        />
        {page.nextCursor && !page.error ? (
          <div className="space-y-2 p-4">
            {query.trim() ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'orchestrationHistory.moreMayMatch',
                  'More events may match. Load the next page to check.'
                )}
              </p>
            ) : null}
            <Button variant="outline" size="sm" disabled={page.loading} onClick={onLoadMore}>
              {translate('orchestrationHistory.loadMoreEvents', 'Load more events')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
