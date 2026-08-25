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
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import { formatAutomationSchedule } from '../../../../shared/automation-schedules'
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
import type { AutomationHostTarget } from './automation-host-client'
import { getLocalAutomationLastRunSnapshot } from './automation-list-last-run'
import { AutomationListLastRunCell } from './AutomationListLastRunCell'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { getAgentLabel } from './automation-draft-model'
import { formatAutomationCost } from './automation-usage-model'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import { LIST_TABLE_ROW_CLASS, LIST_TABLE_ROW_SELECTED_CLASS } from '@/lib/list-table-layout'
import { isPortaledRowMenuClick, isRowActivationKey } from '@/lib/list-row-interaction'
import { AutomationListStatusCell } from './AutomationListStatusCell'
import { translate } from '@/i18n/i18n'

export function AutomationListLocalRows({
  automations,
  selectedId,
  isSelectedLocal,
  lastRunByAutomationId,
  relativeNow,
  repoMap,
  worktreeMap,
  projectHostSetups,
  sshConnectionStates,
  runtimeStatusByEnvironmentId,
  automationHostTarget,
  automationSourceHostAvailabilityById,
  hostLabelById,
  onSelect,
  onRunNow,
  onEdit,
  onToggle,
  onDelete
}: {
  automations: readonly Automation[]
  selectedId: string | null | undefined
  isSelectedLocal: boolean
  lastRunByAutomationId: ReadonlyMap<string, AutomationRun>
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
  hostLabelById: ReadonlyMap<string, string>
  onSelect: (automationId: string) => void
  onRunNow: (automation: Automation) => void
  onEdit: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
}): React.JSX.Element {
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
        const projectLabel =
          automationRepo?.displayName ??
          translate('auto.components.automations.AutomationsPage.13118faadf', 'Unknown project')
        const scheduleLabel = formatAutomationSchedule(automation.rrule)
        const nextRunLabel = automation.enabled
          ? formatAutomationDateTimeWithRelative(automation.nextRunAt, relativeNow)
          : translate('auto.components.automations.AutomationsPage.paused', 'Paused')
        const isSelected = isSelectedLocal && selectedId === automation.id
        const agentLabel = getAgentLabel(automation.agentId)
        const hostId =
          automation.runContext?.hostId ??
          (automationRepo ? getRepoExecutionHostId(automationRepo) : null)
        const hostLabel = hostId
          ? (hostLabelById.get(hostId) ?? getExecutionHostLabel(hostId))
          : getLocalExecutionHostLabel()
        const lastRun = lastRunByAutomationId.get(automation.id)
        const lastRunSnapshot = getLocalAutomationLastRunSnapshot(automation, lastRun)
        const lastRunCost =
          lastRun?.usage?.status === 'known'
            ? formatAutomationCost(lastRun.usage.estimatedCostUsd)
            : formatAutomationCost(null)
        const agentTooltipLabel = `${agentLabel} · ${hostLabel} · ${lastRunCost}`

        const actionItems = (
          <>
            <MenuRunItem
              disabled={!automationRunAvailability.canRunNow}
              label={
                automationRunAvailability.canRunNow
                  ? translate('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')
                  : automationRunAvailability.message
              }
              onSelect={() => onRunNow(automation)}
            />
            <MenuItem
              icon={<Pencil className="size-3.5" />}
              label={translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
              onSelect={() => onEdit(automation)}
            />
            <MenuItem
              icon={
                automation.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />
              }
              label={
                automation.enabled
                  ? translate('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
                  : translate('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')
              }
              onSelect={() => onToggle(automation)}
            />
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 className="size-3.5" />}
              label={translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
              variant="destructive"
              onSelect={() => onDelete(automation)}
            />
          </>
        )

        return (
          <ContextMenu key={automation.id}>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                data-current={isSelected ? 'true' : undefined}
                onClick={(event) => {
                  // Why: Radix portals menus out of the row DOM, but React still
                  // bubbles those clicks here — ignore so menu actions don't open detail.
                  if (isPortaledRowMenuClick(event)) {
                    return
                  }
                  onSelect(automation.id)
                }}
                onKeyDown={(event) => {
                  if (!isRowActivationKey(event)) {
                    return
                  }
                  event.preventDefault()
                  onSelect(automation.id)
                }}
                className={cn(
                  AUTOMATIONS_TABLE_GRID_CLASS,
                  LIST_TABLE_ROW_CLASS,
                  isSelected && LIST_TABLE_ROW_SELECTED_CLASS
                )}
              >
                <span className="min-w-0 truncate font-medium">{automation.name}</span>
                <span className="min-w-0 truncate text-muted-foreground" title={scheduleLabel}>
                  {scheduleLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={projectLabel}>
                  {projectLabel}
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
                      disabled={!automationRunAvailability.canRunNow}
                      onSelect={() => {
                        if (automationRunAvailability.canRunNow) {
                          onRunNow(automation)
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
                    <DropdownMenuItem onSelect={() => onEdit(automation)}>
                      <Pencil className="size-3.5" />
                      {translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onToggle(automation)}>
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
                    <DropdownMenuItem variant="destructive" onSelect={() => onDelete(automation)}>
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
  icon,
  label,
  onSelect,
  variant
}: {
  icon: React.ReactNode
  label: string
  onSelect: () => void
  variant?: 'destructive'
}): React.JSX.Element {
  return (
    <ContextMenuItem variant={variant} onSelect={onSelect}>
      {icon}
      {label}
    </ContextMenuItem>
  )
}

function MenuSeparator(): React.JSX.Element {
  return <ContextMenuSeparator />
}
