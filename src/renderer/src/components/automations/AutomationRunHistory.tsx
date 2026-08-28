import React, { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  formatAutomationDateTime,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from './automation-page-parts'
import {
  formatAutomationCost,
  formatAutomationTokens,
  getAutomationUsageStatusLabel
} from './automation-usage-model'
import { automationRunOccurrenceLabel } from './automation-run-occurrences'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import { AutomationOwnerConflictNotice } from './AutomationOwnerConflictNotice'
import type { AutomationActionNotice } from './automation-row-action-dispatch'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import { translate } from '@/i18n/i18n'

type AutomationRunHistoryProps = {
  runs: AutomationRun[]
  automationId: string
  worktreeMap: ReadonlyMap<string, Worktree>
  /** Set when the history read failed; the runs below are unknown, not zero. */
  notice?: AutomationActionNotice | null
  onRecoverHistory?: (action: AutomationHostRecoveryAction) => void
  onOpenRun: (run: AutomationRun) => void
}

export function AutomationRunHistory({
  runs,
  automationId,
  worktreeMap,
  notice,
  onRecoverHistory,
  onOpenRun
}: AutomationRunHistoryProps): React.JSX.Element {
  const [selectedRunState, setSelectedRunState] = useState<{
    automationId: string
    runId: string | null
  }>(() => ({
    automationId,
    runId: null
  }))
  const runCountLabel = useMemo(() => {
    const completed = runs.filter((run) => run.status === 'completed').length
    return `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} · ${completed} completed`
  }, [runs])

  const selectedRunId =
    selectedRunState.automationId === automationId ? selectedRunState.runId : null
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null

  return (
    <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="text-sm font-medium">
          {translate('auto.components.automations.AutomationRunHistory.53fc5f07ab', 'Run history')}
        </div>
        {/* A failed read knows no counts; "0 runs" would answer a question nobody asked the host. */}
        {notice ? null : <div className="text-xs text-muted-foreground">{runCountLabel}</div>}
      </div>
      <div className="min-h-[18rem] min-w-0">
        <div className="grid grid-cols-[minmax(9rem,1fr)_minmax(10rem,1.1fr)_minmax(5rem,.55fr)_minmax(5rem,.55fr)_minmax(6rem,auto)] gap-3 border-b border-border/50 px-3 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
          <div>
            {translate('auto.components.automations.AutomationRunHistory.8faaa00726', 'Run')}
          </div>
          <div>
            {translate('auto.components.automations.AutomationRunHistory.149c0b49c7', 'Workspace')}
          </div>
          <div>
            {translate('auto.components.automations.AutomationRunHistory.86a248187e', 'Spend')}
          </div>
          <div>
            {translate('auto.components.automations.AutomationRunHistory.13988187b3', 'Tokens')}
          </div>
          <div>
            {translate('auto.components.automations.AutomationRunHistory.9974a2b429', 'Status')}
          </div>
        </div>
        <div className="divide-y divide-border/50">
          {runs.map((run) => {
            const runWorktree = run.workspaceId ? (worktreeMap.get(run.workspaceId) ?? null) : null
            const workspaceLabel = getAutomationRunWorkspaceDisplay({
              run,
              worktree: runWorktree
            })
            const usageLabel = getAutomationUsageStatusLabel(run.usage)
            const occurrenceLabel = automationRunOccurrenceLabel(run)
            return (
              <button
                key={run.id}
                type="button"
                data-current={selectedRun?.id === run.id}
                className={cn(
                  'grid w-full grid-cols-[minmax(9rem,1fr)_minmax(10rem,1.1fr)_minmax(5rem,.55fr)_minmax(5rem,.55fr)_minmax(6rem,auto)] items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  selectedRun?.id === run.id && 'bg-accent text-accent-foreground'
                )}
                onClick={() => {
                  setSelectedRunState({ automationId, runId: run.id })
                  onOpenRun(run)
                }}
              >
                <div className="min-w-0">
                  <div>{formatAutomationDateTime(run.scheduledFor)}</div>
                  {/* The row's own date is the first occurrence; only this line says it recurred. */}
                  {occurrenceLabel ? (
                    <div
                      data-testid="automation-run-occurrences"
                      className="mt-1 truncate text-xs text-foreground"
                    >
                      {occurrenceLabel}
                    </div>
                  ) : null}
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {workspaceLabel.detailLabel}
                  </div>
                </div>
                <div
                  className={
                    workspaceLabel.muted
                      ? 'min-w-0 truncate text-muted-foreground'
                      : 'min-w-0 truncate text-foreground'
                  }
                  title={workspaceLabel.title}
                >
                  {workspaceLabel.rowLabel}
                </div>
                <div
                  className={
                    run.usage?.status === 'known'
                      ? 'text-sm tabular-nums'
                      : 'text-sm text-muted-foreground'
                  }
                  title={usageLabel}
                >
                  {formatAutomationCost(run.usage?.estimatedCostUsd)}
                </div>
                <div
                  className={
                    run.usage?.status === 'known'
                      ? 'text-sm tabular-nums'
                      : 'text-sm text-muted-foreground'
                  }
                  title={usageLabel}
                >
                  {run.usage?.status === 'known'
                    ? formatAutomationTokens(run.usage.totalTokens)
                    : translate(
                        'auto.components.automations.AutomationRunHistory.a00e38d1a3',
                        'n/a'
                      )}
                </div>
                <div className="flex justify-start">
                  <Badge variant={getAutomationRunStatusVariant(run.status)}>
                    {getAutomationRunStatusLabel(run.status)}
                  </Badge>
                </div>
              </button>
            )
          })}
          {notice ? (
            <div className="grid gap-2 px-3 py-6" data-testid="automation-run-history-failure">
              <p className="text-center text-sm text-foreground">
                {translate(
                  'auto.components.automations.AutomationRunHistory.historyUnavailable',
                  'Run history could not be loaded for this automation.'
                )}
              </p>
              <AutomationOwnerConflictNotice notice={notice} onRecover={onRecoverHistory} />
            </div>
          ) : runs.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {translate(
                'auto.components.automations.AutomationRunHistory.402651bfb6',
                'No runs yet.'
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
