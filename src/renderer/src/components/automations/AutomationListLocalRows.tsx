import React from 'react'
import { Clock, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import { formatAutomationSchedule } from '../../../../shared/automation-schedules'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { ProjectHostSetup, Repo, Worktree } from '../../../../shared/types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import type { AutomationHostTarget } from './automation-host-client'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'
import {
  formatAutomationCost,
  formatAutomationTokens,
  summarizeAutomationRunUsage
} from './automation-usage-model'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { getAgentLabel } from './automation-draft-model'
import { translate } from '@/i18n/i18n'

export function AutomationListLocalRows({
  automations,
  selectedId,
  isSelectedLocal,
  runs,
  relativeNow,
  repoMap,
  worktreeMap,
  projectHostSetups,
  sshConnectionStates,
  runtimeStatusByEnvironmentId,
  automationHostTarget,
  automationSourceHostAvailabilityById,
  onSelect,
  onRunNow,
  onEdit,
  onToggle,
  onDelete
}: {
  automations: readonly Automation[]
  selectedId: string | null | undefined
  isSelectedLocal: boolean
  runs: readonly AutomationRun[]
  relativeNow: number
  repoMap: ReadonlyMap<string, Repo>
  worktreeMap: ReadonlyMap<string, Worktree>
  projectHostSetups: readonly ProjectHostSetup[]
  sshConnectionStates: ReadonlyMap<string, Pick<SshConnectionState, 'status'>>
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    { status: RuntimeStatus | null; checkedAt: number }
  >
  automationHostTarget: AutomationHostTarget | null
  automationSourceHostAvailabilityById: ReadonlyMap<string, TaskSourceHostAvailability[]>
  onSelect: (automationId: string) => void
  onRunNow: (automation: Automation) => void
  onEdit: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
}): React.JSX.Element {
  // Why: one pass over runs instead of a full scan per rendered automation —
  // this list re-renders on the relativeNow timer.
  const runsByAutomationId = React.useMemo(() => {
    const grouped = new Map<string, AutomationRun[]>()
    for (const run of runs) {
      const existing = grouped.get(run.automationId)
      if (existing) {
        existing.push(run)
      } else {
        grouped.set(run.automationId, [run])
      }
    }
    return grouped
  }, [runs])
  return (
    <>
      {automations.map((automation) => {
        const automationRepo = repoMap.get(getAutomationRunRepoId(automation))
        const automationWorktree = automation.workspaceId
          ? worktreeMap.get(automation.workspaceId)
          : null
        const automationRunAvailability = getAutomationTargetAvailability({
          automation,
          repo: automationRepo,
          workspace: automationWorktree,
          projectHostSetups,
          sshConnectionStates,
          runtimeStatusByEnvironmentId,
          automationHostTarget,
          sourceHostAvailability: automationSourceHostAvailabilityById.get(automation.id)
        })
        const baseRefLabel =
          automation.baseBranch ??
          automationRepo?.worktreeBaseRef ??
          translate(
            'auto.components.automations.AutomationsPage.projectDefaultBaseRef',
            'project default'
          )
        const workspaceLabel =
          automation.workspaceMode === 'new_per_run'
            ? translate(
                'auto.components.automations.AutomationsPage.createFromBaseRef',
                'Create from {{baseRef}}',
                { baseRef: baseRefLabel }
              )
            : (automationWorktree?.displayName ??
              translate(
                'auto.components.automations.AutomationsPage.missingWorkspace',
                'Missing workspace'
              ))
        const usageSummary = summarizeAutomationRunUsage(
          runsByAutomationId.get(automation.id) ?? []
        )
        const usageText =
          usageSummary.knownRuns > 0
            ? translate(
                'auto.components.automations.AutomationsPage.runUsageSummary',
                '{{cost}} est. · {{tokens}} tokens',
                {
                  cost: formatAutomationCost(usageSummary.estimatedCostUsd),
                  tokens: formatAutomationTokens(usageSummary.totalTokens)
                }
              )
            : usageSummary.unavailableRuns > 0
              ? translate(
                  'auto.components.automations.AutomationsPage.usageUnavailable',
                  'Usage unavailable'
                )
              : translate(
                  'auto.components.automations.AutomationsPage.noRunUsageYet',
                  'No run usage yet'
                )
        const nextRunLabel = automation.enabled
          ? formatAutomationDateTimeWithRelative(automation.nextRunAt, relativeNow)
          : translate('auto.components.automations.AutomationsPage.paused', 'Paused')
        const scheduleLabel = formatAutomationSchedule(automation.rrule)
        return (
          <ContextMenu key={automation.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(automation.id)}
                className={cn(
                  'mb-1 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                  isSelectedLocal && selectedId === automation.id
                    ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
                    : 'border-transparent hover:bg-muted/50'
                )}
              >
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        automation.enabled ? 'bg-foreground' : 'bg-muted-foreground/40'
                      )}
                    />
                    <span className="truncate font-medium">{automation.name}</span>
                  </span>
                  <span className="mt-1 block truncate text-xs font-medium text-foreground/80">
                    {scheduleLabel}
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {automationRepo ? (
                      <RepoBadgeLabel
                        name={automationRepo.displayName}
                        color={automationRepo.badgeColor}
                        badgeClassName="size-1.5"
                      />
                    ) : (
                      <span>
                        {translate(
                          'auto.components.automations.AutomationsPage.13118faadf',
                          'Unknown project'
                        )}
                      </span>
                    )}
                    <span className="shrink-0">/</span>
                    <span className="truncate">{workspaceLabel}</span>
                    <span className="shrink-0">·</span>
                    <span className="truncate">{getAgentLabel(automation.agentId)}</span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {usageText}
                  </span>
                </span>
                <span className="flex max-w-28 flex-col items-end gap-1 text-right text-xs text-muted-foreground">
                  <Clock className="size-3.5" />
                  <span className="line-clamp-2">{nextRunLabel}</span>
                </span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem
                disabled={!automationRunAvailability.canRunNow}
                onSelect={(event) => {
                  if (!automationRunAvailability.canRunNow) {
                    event.preventDefault()
                    return
                  }
                  onRunNow(automation)
                }}
              >
                <Play className="size-3.5" />
                <span className="min-w-0 truncate">
                  {automationRunAvailability.canRunNow
                    ? translate('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')
                    : automationRunAvailability.message}
                </span>
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onEdit(automation)}>
                <Pencil className="size-3.5" />
                {translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onToggle(automation)}>
                {automation.enabled ? (
                  <Pause className="size-3.5" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {automation.enabled
                  ? translate('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
                  : translate('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => onDelete(automation)}>
                <Trash2 className="size-3.5" />
                {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </>
  )
}
