import React, { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { AutomationRunsDashboardEntry } from './automation-runs-dashboard-model'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import {
  AUTOMATION_RUNS_DASHBOARD_GRID_CLASS,
  AutomationRunIdentityCell,
  AutomationRunResultCell,
  AutomationRunSpendCell,
  AutomationRunTableHeaderCells,
  AutomationRunWorkspaceCell
} from './AutomationRunTableCells'
import { useRevealAutomationRun } from './use-reveal-automation-run'

const RUN_ROW_HEIGHT_PX = 59
const RUN_ROW_OVERSCAN = 10
const RUNS_VIEWPORT_INITIAL_RECT = { width: 1024, height: 600 }

export function AutomationRunsTable({
  entries,
  loading,
  hasMore,
  onLoadMore,
  onOpenRun,
  worktreeForRun
}: {
  entries: readonly AutomationRunsDashboardEntry[]
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  onOpenRun: (entry: AutomationRunsDashboardEntry) => void
  /** The live workspace a run launched, if it still exists. */
  worktreeForRun: (entry: AutomationRunsDashboardEntry) => Worktree | null
}): React.JSX.Element {
  const t = useTranslate()
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
  useRevealAutomationRun(
    (runId) => entries.findIndex((entry) => entry.run.id === runId),
    (index) => virtualizer.scrollToIndex(index, { align: 'center' })
  )

  return (
    <div className="flex min-h-[15rem] flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-card">
      <div
        ref={scrollRef}
        className="scrollbar-sleek flex min-h-0 flex-1 flex-col overflow-auto"
        onScroll={(event) => {
          const { clientHeight, scrollHeight, scrollTop } = event.currentTarget
          const nearEnd = scrollHeight - scrollTop - clientHeight < RUN_ROW_HEIGHT_PX * 10
          if (hasMore && !loading && nearEnd && !loadMoreRequestedRef.current) {
            loadMoreRequestedRef.current = true
            onLoadMore()
          }
        }}
      >
        <div
          className={cn(
            AUTOMATION_RUNS_DASHBOARD_GRID_CLASS,
            'sticky top-0 z-10 shrink-0 border-b border-border/60 bg-card px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground'
          )}
        >
          <AutomationRunTableHeaderCells withAutomation />
        </div>
        {loading && entries.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('auto.components.automations.AutomationRunsDashboard.loading', 'Loading runs…')}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
            <div className="text-sm font-medium">
              {t('auto.components.automations.AutomationRunsDashboard.noRuns', 'No runs yet')}
            </div>
            <div className="text-xs text-muted-foreground">
              {t(
                'auto.components.automations.AutomationRunsDashboard.emptyDescription',
                'Runs appear here after an automation is triggered.'
              )}
            </div>
          </div>
        ) : (
          <div className="relative w-full shrink-0" style={{ height: virtualizer.getTotalSize() }}>
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
                    data-automation-run-id={entry.run.id}
                    className={cn(
                      AUTOMATION_RUNS_DASHBOARD_GRID_CLASS,
                      'items-center px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                    )}
                    onClick={() => onOpenRun(entry)}
                  >
                    <AutomationRunIdentityCell run={entry.run} />
                    <div className="min-w-0 truncate" title={entry.row.automation.name}>
                      {entry.row.automation.name}
                    </div>
                    <AutomationRunResultCell status={entry.run.status} />
                    <AutomationRunWorkspaceCell
                      display={getAutomationRunWorkspaceDisplay(
                        {
                          run: entry.run,
                          worktree: entry.run.workspaceId ? worktreeForRun(entry) : null
                        },
                        t
                      )}
                    />
                    <AutomationRunSpendCell
                      estimatedCostUsd={entry.run.estimatedCostUsd}
                      usageKnown={entry.run.usageKnown}
                    />
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
