import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/class-names'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getAutomationUsageStatusLabel } from './automation-usage-model'
import {
  AUTOMATION_RUN_TABLE_GRID_CLASS,
  AutomationRunIdentityCell,
  AutomationRunResultCell,
  AutomationRunSpendCell,
  AutomationRunTableHeaderCells,
  AutomationRunWorkspaceCell
} from './AutomationRunTableCells'
import { automationRunOccurrenceLabel, isAutomationRunFolded } from './automation-run-occurrences'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import { useRevealAutomationRun } from './use-reveal-automation-run'
import { AutomationOwnerConflictNotice } from '../hosts/AutomationOwnerConflictNotice'
import type { AutomationActionNotice } from '../hosts/automation-row-action-dispatch'
import type { AutomationHostRecoveryAction } from '../hosts/automation-host-status-descriptors'
import {
  getAutomationRunHistoryArrowTarget,
  isAutomationRunHistoryArrowKey,
  shouldHandleAutomationRunHistoryKey
} from './automation-run-history-keyboard-navigation'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

// Base height covers date/workspace/padding; only folded occurrence text adds a line.
const RUN_ROW_HEIGHT_PX = 57
const RUN_ROW_OCCURRENCE_LINE_PX = 20
const RUN_ROW_OVERSCAN = 10
// Seed viewport geometry because first paint and happy-dom report zero height, which would mount no rows.
const RUNS_VIEWPORT_INITIAL_RECT = { width: 1024, height: 600 }

const RUN_ROW_GRID_CLASS = AUTOMATION_RUN_TABLE_GRID_CLASS
// Share scroller width with rows, including scrollbar gutter; opaque sticky headers hide scrolled content.
const RUN_ROW_HEADER_SURFACE_CLASS =
  '[background:color-mix(in_srgb,var(--muted)_20%,var(--background))]'

type AutomationRunHistoryProps = {
  runs: AutomationRun[]
  automationId: string
  worktreeMap: ReadonlyMap<string, Worktree>
  /** Set when the history read failed; the runs below are unknown, not zero. */
  notice?: AutomationActionNotice | null
  onRecoverHistory?: (action: AutomationHostRecoveryAction) => void
  onOpenRun: (run: AutomationRun) => void
}

/** "16 runs · 12 completed": the summary under an automation's Runs title. */
export function formatAutomationRunCountSummary(
  runs: readonly Pick<AutomationRun, 'status'>[],
  t: ReturnType<typeof useTranslate>
): string {
  const completed = runs.filter((run) => run.status === 'completed').length
  return t(
    'auto.components.automations.runHistory.runCountSummary',
    '{{count}} runs · {{completed}} completed',
    { count: runs.length, completed, defaultValue_one: '{{count}} run · {{completed}} completed' }
  )
}

export function AutomationRunHistory({
  runs,
  automationId,
  worktreeMap,
  notice,
  onRecoverHistory,
  onOpenRun
}: AutomationRunHistoryProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  // Offset virtual coordinates/scrollToIndex by the sticky header height.
  const [scrollMargin, setScrollMargin] = useState(0)
  const [selectedRunState, setSelectedRunState] = useState<{
    automationId: string
    runId: string | null
  }>(() => ({
    automationId,
    runId: null
  }))

  const selectedRunId =
    selectedRunState.automationId === automationId ? selectedRunState.runId : null
  const selectedIndex = selectedRunId ? runs.findIndex((run) => run.id === selectedRunId) : -1
  const selectedRun = (selectedIndex >= 0 ? runs[selectedIndex] : undefined) ?? runs[0] ?? null

  // Keep both callbacks stable: virtual-core memoizes measurements via getItemKey, and inline estimates rewalk uncached history each render.
  const estimateRunRowSize = useCallback(
    (index: number): number => {
      const run = runs[index]
      // Check folding without formatting labels/dates for every unmounted run.
      return run && isAutomationRunFolded(run)
        ? RUN_ROW_HEIGHT_PX + RUN_ROW_OCCURRENCE_LINE_PX
        : RUN_ROW_HEIGHT_PX
    },
    [runs]
  )
  const getRunRowKey = useCallback(
    (index: number): string | number => runs[index]?.id ?? index,
    [runs]
  )

  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateRunRowSize,
    overscan: RUN_ROW_OVERSCAN,
    initialRect: RUNS_VIEWPORT_INITIAL_RECT,
    getItemKey: getRunRowKey,
    scrollMargin,
    // Inset top-aligned rows below the sticky header.
    scrollPaddingStart: scrollMargin
  })

  useRevealAutomationRun(
    (runId) => runs.findIndex((run) => run.id === runId),
    (index) => virtualizer.scrollToIndex(index, { align: 'center' })
  )

  // Track the rows’ header offset across zoom/font changes.
  useLayoutEffect(() => {
    const rows = rowsRef.current
    const scrollElement = scrollRef.current
    if (!rows || !scrollElement) {
      return
    }
    const measure = (): void => {
      const next = Math.round(
        rows.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top +
          scrollElement.scrollTop
      )
      setScrollMargin((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined' || !headerRef.current) {
      return
    }
    // Only header resizing shifts the offset; observing rows would fire on every mount without a geometry change.
    const observer = new ResizeObserver(measure)
    observer.observe(headerRef.current)
    return () => observer.disconnect()
  }, [])

  const findRunRow = React.useCallback(
    (runId: string): HTMLElement | null =>
      containerRef.current?.querySelector<HTMLElement>(`[data-automation-run-id="${runId}"]`) ??
      null,
    []
  )

  // Keep one window listener; refs supply current runs/selection across page renders.
  const keyboardInputRef = useRef({ runs, selectedRun, automationId, notice, onOpenRun })
  React.useEffect(() => {
    keyboardInputRef.current = { runs, selectedRun, automationId, notice, onOpenRun }
  })
  const pendingFocusRunIdRef = useRef<string | null>(null)

  // Drop pending focus for removed runs so their later reappearance cannot steal focus.
  React.useEffect(() => {
    const pendingRunId = pendingFocusRunIdRef.current
    if (pendingRunId && !runs.some((run) => run.id === pendingRunId)) {
      pendingFocusRunIdRef.current = null
    }
  }, [runs])

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const input = keyboardInputRef.current
      if (input.runs.length === 0 || input.notice || !shouldHandleAutomationRunHistoryKey(event)) {
        return
      }

      if (event.key === 'Enter') {
        if (input.selectedRun) {
          event.preventDefault()
          input.onOpenRun(input.selectedRun)
        }
        return
      }

      if (isAutomationRunHistoryArrowKey(event.key)) {
        const targetRun = getAutomationRunHistoryArrowTarget({
          runs: input.runs,
          selectedRunId: input.selectedRun?.id ?? null,
          key: event.key
        })
        if (targetRun) {
          event.preventDefault()
          setSelectedRunState({ automationId: input.automationId, runId: targetRun.id })
          // Enter follows focused controls; defer focus until scrolling mounts the selected row.
          pendingFocusRunIdRef.current = targetRun.id
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  React.useEffect(() => {
    if (selectedIndex >= 0) {
      virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
    }
  }, [selectedIndex, virtualizer])

  // Check every render because scrolling may mount the pending focus target on a later pass.
  React.useEffect(() => {
    const pendingRunId = pendingFocusRunIdRef.current
    if (!pendingRunId) {
      return
    }
    const element = findRunRow(pendingRunId)
    if (element) {
      pendingFocusRunIdRef.current = null
      element.focus?.({ preventScroll: true })
    }
  })

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-muted/20 shadow-sm"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div ref={scrollRef} className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
          <div
            ref={headerRef}
            className={cn(
              RUN_ROW_GRID_CLASS,
              RUN_ROW_HEADER_SURFACE_CLASS,
              'sticky top-0 z-10 border-b border-border/50 px-3 py-1.5 text-[11px] font-medium uppercase text-muted-foreground'
            )}
          >
            <AutomationRunTableHeaderCells />
          </div>
          <div
            ref={rowsRef}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const run = runs[virtualRow.index]
              if (!run) {
                return null
              }
              const runWorktree = run.workspaceId ? (worktreeMap.get(run.id) ?? null) : null
              const workspaceLabel = getAutomationRunWorkspaceDisplay(
                {
                  run,
                  worktree: runWorktree
                },
                t
              )
              const usageLabel = getAutomationUsageStatusLabel(run.usage, t, intlLocale)
              const occurrenceLabel = automationRunOccurrenceLabel(run, t, intlLocale)
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full border-b border-border/50"
                  style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
                >
                  <button
                    type="button"
                    data-automation-run-id={run.id}
                    data-current={selectedRun?.id === run.id}
                    aria-current={selectedRun?.id === run.id || undefined}
                    className={cn(
                      RUN_ROW_GRID_CLASS,
                      'items-center px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      selectedRun?.id === run.id && 'bg-accent text-accent-foreground'
                    )}
                    onClick={() => {
                      setSelectedRunState({ automationId, runId: run.id })
                      onOpenRun(run)
                    }}
                  >
                    <AutomationRunIdentityCell
                      run={run}
                      extra={
                        // The row's own date is the first occurrence; only this line says it recurred.
                        occurrenceLabel ? (
                          <div
                            data-testid="automation-run-occurrences"
                            className="mt-1 truncate text-xs text-foreground"
                          >
                            {occurrenceLabel}
                          </div>
                        ) : null
                      }
                    />
                    <AutomationRunResultCell status={run.status} />
                    <AutomationRunWorkspaceCell display={workspaceLabel} />
                    <AutomationRunSpendCell
                      estimatedCostUsd={run.usage?.estimatedCostUsd}
                      usageKnown={run.usage?.status === 'known'}
                      title={usageLabel}
                    />
                  </button>
                </div>
              )
            })}
          </div>
          {notice ? (
            <div className="grid gap-2 px-3 py-6" data-testid="automation-run-history-failure">
              <p className="text-center text-sm text-foreground">
                {t(
                  'auto.components.automations.AutomationRunHistory.historyUnavailable',
                  'Run history is unavailable from this host. This does not mean the automation failed or has no runs.'
                )}
              </p>
              <AutomationOwnerConflictNotice notice={notice} onRecover={onRecoverHistory} />
            </div>
          ) : runs.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('auto.components.automations.AutomationRunHistory.402651bfb6', 'No runs yet.')}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
