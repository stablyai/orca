import React from 'react'
import { MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import { formatUiAutomationSchedule } from './automation-schedule-label'
import {
  getExecutionHostLabel,
  getLocalExecutionHostLabel,
  getRepoExecutionHostId
} from '../../../../shared/execution-host'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import type { AutomationRowAction } from './automation-captured-owner'
import type { AutomationHostTarget } from './automation-host-client'
import {
  getAutomationRowLastRunSnapshot,
  getLocalAutomationLastRunSnapshot
} from './automation-list-last-run'
import { AutomationListLastRunCell } from './AutomationListLastRunCell'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { getAgentLabel } from './automation-draft-model'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  formatAutomationCost,
  formatAutomationTokens,
  type AutomationUsageSummary
} from './automation-usage-model'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import {
  LIST_TABLE_ROW_CLASS,
  LIST_TABLE_ROW_SELECTED_CLASS,
  LIST_TABLE_STICKY_ROW_CELL_CLASS
} from '@/lib/list-table-layout'
import { isPortaledRowMenuClick, isRowActivationKey } from '@/lib/list-row-interaction'
import { AutomationListStatusCell } from './AutomationListStatusCell'
import { translate } from '@/i18n/i18n'

export type AutomationListLocalRowsProps = {
  rows: readonly AutomationListRow[]
  selectedRowKey: string | null | undefined
  isSelectedLocal: boolean
  lastRunByAutomationId: ReadonlyMap<string, AutomationRun>
  relativeNow: number
  repoMap: ReadonlyMap<string, Repo>
  worktreeMap: ReadonlyMap<string, Worktree>
  repoForRow?: (row: AutomationListRow) => Repo | undefined
  worktreeForRow?: (row: AutomationListRow, repo: Repo | undefined) => Worktree | undefined
  projectHostSetups: readonly ProjectHostSetup[]
  sshConnectionStates: ReadonlyMap<string, Pick<SshConnectionState, 'status'>>
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    { status: RuntimeStatus | null; checkedAt: number }
  >
  hostTargetFor: (row: AutomationListRow) => AutomationHostTarget | null
  automationSourceHostAvailabilityByRowKey: ReadonlyMap<string, TaskSourceHostAvailability[]>
  hostLabelById?: ReadonlyMap<string, string>
  isActionEnabled?: (row: AutomationListRow, action: AutomationRowAction) => boolean
  onSelect: (rowKey: string) => void
  onRunNow: (row: AutomationListRow) => void
  onEdit: (row: AutomationListRow) => void
  onToggle: (row: AutomationListRow) => void
  onDelete: (row: AutomationListRow) => void
}

const EMPTY_HOST_LABELS: ReadonlyMap<string, string> = new Map()

function automationUsageText(summary: AutomationUsageSummary | undefined): string {
  if (!summary || summary.unavailableRuns > 0) {
    return summary?.knownRuns
      ? usageAmountText(summary)
      : translate(
          'auto.components.automations.AutomationsPage.usageUnavailable',
          'Usage unavailable'
        )
  }
  return summary.knownRuns > 0
    ? usageAmountText(summary)
    : translate('auto.components.automations.AutomationsPage.noRunUsageYet', 'No run usage yet')
}

function usageAmountText(summary: AutomationUsageSummary): string {
  return translate(
    'auto.components.automations.AutomationsPage.runUsageSummary',
    '{{cost}} est. · {{tokens}} tokens',
    {
      cost: formatAutomationCost(summary.estimatedCostUsd),
      tokens: formatAutomationTokens(summary.totalTokens)
    }
  )
}

export function AutomationListLocalRows({
  rows,
  selectedRowKey,
  isSelectedLocal,
  lastRunByAutomationId,
  relativeNow,
  repoMap,
  worktreeMap,
  repoForRow,
  worktreeForRow,
  projectHostSetups,
  sshConnectionStates,
  runtimeStatusByEnvironmentId,
  hostTargetFor,
  automationSourceHostAvailabilityByRowKey,
  hostLabelById = EMPTY_HOST_LABELS,
  isActionEnabled,
  onSelect,
  onRunNow,
  onEdit,
  onToggle,
  onDelete
}: AutomationListLocalRowsProps): React.JSX.Element {
  const allows = (row: AutomationListRow, action: AutomationRowAction): boolean =>
    isActionEnabled?.(row, action) ?? true
  return (
    <>
      {rows.map((row) => {
        const { automation } = row
        const automationRepo = repoForRow?.(row) ?? repoMap.get(getAutomationRunRepoId(automation))
        const automationWorktree = automation.workspaceId
          ? (worktreeForRow?.(row, automationRepo) ?? worktreeMap.get(automation.workspaceId))
          : null
        const automationRunAvailability = getAutomationTargetAvailability({
          automation,
          repo: automationRepo,
          workspace: automationWorktree,
          projectHostSetups,
          sshConnectionStates,
          runtimeStatusByEnvironmentId,
          automationHostTarget: hostTargetFor(row),
          sourceHostAvailability: automationSourceHostAvailabilityByRowKey.get(row.key)
        })
        const projectLabel =
          automationRepo?.displayName ??
          translate('auto.components.automations.AutomationsPage.13118faadf', 'Unknown project')
        const scheduleLabel = formatUiAutomationSchedule(automation.rrule)
        const nextRunLabel = automation.enabled
          ? formatAutomationDateTimeWithRelative(automation.nextRunAt, relativeNow)
          : translate('auto.components.automations.enablement.paused', 'Paused')
        const isSelected = isSelectedLocal && selectedRowKey === row.key
        const agentLabel = getAgentLabel(automation.agentId)
        const hostId =
          automation.runContext?.hostId ??
          (automationRepo ? getRepoExecutionHostId(automationRepo) : null)
        const hostLabel =
          row.hostLabel ||
          (hostId
            ? (hostLabelById.get(hostId) ?? getExecutionHostLabel(hostId))
            : getLocalExecutionHostLabel())
        const agentTooltipLabel = `${agentLabel} · ${hostLabel} · ${automationUsageText(row.usageSummary ?? undefined)}`
        const canRunNow = automationRunAvailability.canRunNow && allows(row, 'run')
        const lastRun = lastRunByAutomationId.get(automation.id)
        // Without a fetched run, the row's projected summary carries the newest
        // retained run's status — the list never downloads run history for this.
        const lastRunSnapshot = lastRun
          ? getLocalAutomationLastRunSnapshot(automation, lastRun)
          : getAutomationRowLastRunSnapshot(row)

        const actionItems = (
          <>
            <MenuRunItem
              disabled={!canRunNow}
              label={
                automationRunAvailability.canRunNow
                  ? translate('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')
                  : automationRunAvailability.message
              }
              onSelect={() => onRunNow(row)}
            />
            <MenuItem
              disabled={!allows(row, 'edit')}
              icon={<Pencil className="size-3.5" />}
              label={translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
              onSelect={() => onEdit(row)}
            />
            <MenuItem
              disabled={!allows(row, 'toggle')}
              icon={
                automation.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />
              }
              label={
                automation.enabled
                  ? translate('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
                  : translate('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')
              }
              onSelect={() => onToggle(row)}
            />
            <MenuSeparator />
            <MenuItem
              disabled={!allows(row, 'delete')}
              icon={<Trash2 className="size-3.5" />}
              label={translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
              variant="destructive"
              onSelect={() => onDelete(row)}
            />
          </>
        )

        return (
          <ContextMenu key={row.key}>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                data-automation-row-id={row.key}
                data-current={isSelected ? 'true' : undefined}
                onClick={(event) => {
                  // Why: Radix portals menus out of the row DOM, but React still
                  // bubbles those clicks here — ignore so menu actions don't open detail.
                  if (isPortaledRowMenuClick(event)) {
                    return
                  }
                  onSelect(row.key)
                }}
                onKeyDown={(event) => {
                  if (!isRowActivationKey(event)) {
                    return
                  }
                  event.preventDefault()
                  onSelect(row.key)
                }}
                className={cn(
                  AUTOMATIONS_TABLE_GRID_CLASS,
                  LIST_TABLE_ROW_CLASS,
                  isSelected && LIST_TABLE_ROW_SELECTED_CLASS
                )}
              >
                <span className={LIST_TABLE_STICKY_ROW_CELL_CLASS}>
                  <span className="min-w-0 truncate font-medium">{automation.name}</span>
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={scheduleLabel}>
                  {scheduleLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={projectLabel}>
                  {projectLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={hostLabel}>
                  {hostLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={nextRunLabel}>
                  {nextRunLabel}
                </span>
                <AutomationListLastRunCell snapshot={lastRunSnapshot} now={relativeNow} />
                <AutomationListStatusCell enabled={automation.enabled} />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="flex items-center justify-center text-muted-foreground"
                      aria-label={agentTooltipLabel}
                    >
                      <AgentIcon agent={automation.agentId} size={16} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {agentTooltipLabel}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-7 text-muted-foreground"
                      aria-label={translate(
                        'auto.components.automations.AutomationListLocalRows.c92c9463c6',
                        'Automation actions'
                      )}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem
                      disabled={!canRunNow}
                      onSelect={() => {
                        if (canRunNow) {
                          onRunNow(row)
                        }
                      }}
                    >
                      <Play className="size-3.5" />
                      <span className="min-w-0 truncate">
                        {automationRunAvailability.canRunNow
                          ? translate(
                              'auto.components.automations.AutomationsPage.2faecab10b',
                              'Run Now'
                            )
                          : automationRunAvailability.message}
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!allows(row, 'edit')} onSelect={() => onEdit(row)}>
                      <Pencil className="size-3.5" />
                      {translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!allows(row, 'toggle')}
                      onSelect={() => onToggle(row)}
                    >
                      {automation.enabled ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {automation.enabled
                        ? translate(
                            'auto.components.automations.AutomationsPage.b457436d6a',
                            'Pause'
                          )
                        : translate(
                            'auto.components.automations.AutomationsPage.376631ef2b',
                            'Resume'
                          )}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={!allows(row, 'delete')}
                      onSelect={() => onDelete(row)}
                    >
                      <Trash2 className="size-3.5" />
                      {translate(
                        'auto.components.automations.AutomationsPage.15e0bfb13b',
                        'Delete'
                      )}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">{actionItems}</ContextMenuContent>
          </ContextMenu>
        )
      })}
    </>
  )
}

function MenuRunItem({
  disabled,
  label,
  onSelect
}: {
  disabled: boolean
  label: string
  onSelect: () => void
}): React.JSX.Element {
  return (
    <ContextMenuItem
      disabled={disabled}
      onSelect={(event) => {
        if (disabled) {
          event.preventDefault()
          return
        }
        onSelect()
      }}
    >
      <Play className="size-3.5" />
      <span className="min-w-0 truncate">{label}</span>
    </ContextMenuItem>
  )
}

function MenuItem({
  disabled,
  icon,
  label,
  onSelect,
  variant
}: {
  disabled?: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
  variant?: 'destructive'
}): React.JSX.Element {
  return (
    <ContextMenuItem disabled={disabled} variant={variant} onSelect={onSelect}>
      {icon}
      {label}
    </ContextMenuItem>
  )
}

function MenuSeparator(): React.JSX.Element {
  return <ContextMenuSeparator />
}
