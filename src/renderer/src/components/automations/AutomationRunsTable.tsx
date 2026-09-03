import React, { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { AutomationRunsDashboardEntry } from './automation-runs-dashboard-model'
import {
  formatAutomationDateTimeWithRelative,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from './automation-page-parts'

const RUN_ROW_HEIGHT_PX = 59
const RUN_ROW_OVERSCAN = 10
const RUNS_VIEWPORT_INITIAL_RECT = { width: 1024, height: 600 }

export function AutomationRunsTable({
  entries,
  loading,
  hasMore,
  onLoadMore,
  onOpenRun
}: {
  entries: readonly AutomationRunsDashboardEntry[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  onOpenRun: (entry: AutomationRunsDashboardEntry) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadMoreRequestedRef = useRef(false)
  useEffect(() => {
    if (!loading) {
      loadMoreRequestedRef.current = false
    }
  }, [loading])
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => RUN_ROW_HEIGHT_PX,
    overscan: RUN_ROW_OVERSCAN,
    initialRect: RUNS_VIEWPORT_INITIAL_RECT,
    getItemKey: (index) => entries[index]?.key ?? index
  })

  return (
    <div className="flex min-h-[18rem] flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="grid shrink-0 grid-cols-[minmax(11rem,1.4fr)_minmax(10rem,1fr)_minmax(5rem,.55fr)_minmax(8rem,.8fr)_minmax(7rem,auto)] gap-3 border-b border-border/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <div>
          {translate(
            'auto.components.automations.AutomationRunsDashboard.automation',
            'Automation'
          )}
        </div>
        <div>
          {translate('auto.components.automations.AutomationRunsDashboard.triggered', 'Triggered')}
        </div>
        <div>
          {translate('auto.components.automations.AutomationRunsDashboard.trigger', 'Trigger')}
        </div>
        <div>{translate('auto.components.automations.AutomationRunsDashboard.host', 'Host')}</div>
        <div>
          {translate('auto.components.automations.AutomationRunsDashboard.status', 'Status')}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="scrollbar-sleek h-[calc(100vh-21rem)] min-h-[15rem] overflow-auto"
        onScroll={(event) => {
          const { clientHeight, scrollHeight, scrollTop } = event.currentTarget
          const nearEnd = scrollHeight - scrollTop - clientHeight < RUN_ROW_HEIGHT_PX * 10
          if (hasMore && !loading && nearEnd && !loadMoreRequestedRef.current) {
            loadMoreRequestedRef.current = true
            onLoadMore()
          }
        }}
      >
        {loading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate(
              'auto.components.automations.AutomationRunsDashboard.loading',
              'Loading runs…'
            )}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <div className="text-sm font-medium">
              {translate(
                'auto.components.automations.AutomationRunsDashboard.noRuns',
                'No runs yet'
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {translate(
                'auto.components.automations.AutomationRunsDashboard.emptyDescription',
                'Runs appear here after an automation is triggered.'
              )}
            </div>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = entries[virtualRow.index]
              if (!entry) {
                return null
              }
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full border-b border-border/50"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <button
                    type="button"
                    data-testid="automation-runs-row"
                    className="grid w-full grid-cols-[minmax(11rem,1.4fr)_minmax(10rem,1fr)_minmax(5rem,.55fr)_minmax(8rem,.8fr)_minmax(7rem,auto)] items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={() => onOpenRun(entry)}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{entry.row.automation.name}</div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {entry.run.title}
                      </div>
                    </div>
                    <div className="min-w-0 truncate text-xs">
                      {formatAutomationDateTimeWithRelative(entry.run.scheduledFor)}
                    </div>
                    <div className="capitalize text-xs text-muted-foreground">
                      {entry.run.trigger}
                    </div>
                    <div className="min-w-0 truncate text-xs" title={entry.row.hostLabel}>
                      {entry.row.hostLabel ||
                        translate(
                          `auto.components.automations.AutomationRunsDashboard.${entry.scope}`,
                          entry.scope === 'local' ? 'Local' : 'Remote'
                        )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={getAutomationRunStatusVariant(entry.run.status)}>
                        {getAutomationRunStatusLabel(entry.run.status)}
                      </Badge>
                      <ChevronRight className="size-3.5 text-muted-foreground" />
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
