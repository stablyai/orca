import { automationNextRunLabel } from '../details/automation-when-label'
import { useBots } from '@/lib/bot-catalog'
import { automationWebhookUrlCopy } from '@/components/bots/webhooks/automation-webhook-url'
import { automationTargetLabel } from '../authoring/automation-bot-target-label'
import { AutomationWontFireMark } from '../details/AutomationWontFireNote'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { botAutomationWhen } from '../../bots/bot-automation-when'
import {
  capturedAutomationOwner,
  type AutomationCapturedOwner,
  type AutomationRowAction
} from '../hosts/automation-captured-owner'
import type { RuntimeEnvironmentSshBucket } from '../../../store/slices/ssh/runtime-environment-ssh'
import React from 'react'
import { Link, MoreHorizontal, Pause, Pencil, Play, ShieldCheck, Trash2 } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { MenuItem, MenuRunItem, MenuSeparator } from './AutomationListRowContextMenuItems'
import { pendingAutomationSetupReviewFromSummary } from '../authoring/automation-setup-review'
import type { SetupTrustMismatch } from '../../../../../shared/worktree/create-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { cn } from '@/lib/class-names'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { getAutomationRunRepoId } from '../../../../../shared/automations/history/automation-run-identity'
import { formatUiAutomationSchedule } from '../details/automation-schedule-label'
import type { SshConnectionState } from '../../../../../shared/remote-runtime/ssh/ssh-types'
import type { ProjectHostSetup } from '../../../../../shared/project/project-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { AutomationHostTarget } from '../hosts/automation-host-client'
import {
  getAutomationRowLastRunSnapshot,
  getLocalAutomationLastRunSnapshot
} from './automation-list-last-run'
import { AutomationListLastRunCell } from './AutomationListLastRunCell'
import { formatAutomationDateTime, formatAutomationNextRun } from '../automation-page-parts'
import { getAutomationTargetAvailability } from '../hosts/automation-target-availability'
import { getAgentLabel } from '../authoring/automation-draft-model'
import { automationProjectName, type AutomationListRow } from './automation-list-row-identity'
import { formatAutomationUsageSummary } from '../runs/automation-usage-model'
import { automationsTableGridClass } from './automations-table-layout'
import { automationRowHostLabel } from './automation-list-host'
import {
  LIST_TABLE_ROW_CLASS,
  LIST_TABLE_ROW_SELECTED_CLASS,
  LIST_TABLE_STICKY_ROW_CELL_CLASS
} from '@/lib/list-interaction/list-table-layout'
import {
  isPortaledRowMenuClick,
  isRowActivationKey
} from '@/lib/list-interaction/list-row-interaction'
import { AutomationListNextRunCell } from './AutomationListNextRunCell'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { wslMovedProjectForAutomation } from '@/store/repos/wsl-moved-projects'

export type AutomationListLocalRowProps = {
  row: AutomationListRow
  capturedOwners?: ReadonlyMap<string, AutomationCapturedOwner>
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
  sshStateByEnvironment?: ReadonlyMap<string, RuntimeEnvironmentSshBucket>
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
  hostTargetFor: (row: AutomationListRow) => AutomationHostTarget | null
  hostLabelById?: ReadonlyMap<string, string>
  isActionEnabled?: (row: AutomationListRow, action: AutomationRowAction) => boolean
  needsMigration?: (row: AutomationListRow) => boolean
  /** The list spans more than one host. */
  showHost?: boolean
  onSelect: (rowKey: string) => void
  onRunNow: (row: AutomationListRow) => void
  onEdit: (row: AutomationListRow) => void
  onToggle: (row: AutomationListRow) => void
  onDelete: (row: AutomationListRow) => void
  onReviewSetup?: (row: AutomationListRow, content: SetupTrustMismatch) => void
}

const EMPTY_HOST_LABELS: ReadonlyMap<string, string> = new Map()

export function AutomationListLocalRow({
  capturedOwners,
  row,
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
  sshStateByEnvironment,
  runtimeStatusByEnvironmentId,
  hostTargetFor,
  hostLabelById = EMPTY_HOST_LABELS,
  isActionEnabled,
  needsMigration,
  showHost = false,
  onSelect,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
  onReviewSetup
}: AutomationListLocalRowProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const allows = (row: AutomationListRow, action: AutomationRowAction): boolean =>
    isActionEnabled?.(row, action) ?? true
  const { automation } = row
  const bots = useBots()
  const automationRepo = repoForRow
    ? repoForRow(row)
    : repoMap.get(getAutomationRunRepoId(automation))
  const automationWorktree = automation.workspaceId
    ? worktreeForRow
      ? worktreeForRow(row, automationRepo)
      : worktreeMap.get(automation.workspaceId)
    : null
  const automationRunAvailability = getAutomationTargetAvailability(
    {
      automation,
      capturedOwner: capturedAutomationOwner(capturedOwners, row.key),
      repo: automationRepo,
      workspace: automationWorktree,
      projectHostSetups,
      sshConnectionStates,
      sshStateByEnvironment,
      runtimeStatusByEnvironmentId,
      automationHostTarget: hostTargetFor(row)
    },
    t
  )
  const projectLabel = automation.bot
    ? automationTargetLabel(automation, automationRepo, bots)
    : (automationProjectName(automation, automationRepo, repoMap, !!needsMigration?.(row)) ??
      t('auto.components.automations.AutomationsPage.13118faadf', 'Unknown project'))
  const scheduleLabel = automation.bot
    ? botAutomationWhen(automation)
    : formatUiAutomationSchedule(automation.rrule, t, intlLocale)
  const nextRunLabel = automation.enabled
    ? automation.bot
      ? automationNextRunLabel(automation, relativeNow)
      : formatAutomationNextRun(automation.nextRunAt, relativeNow, t, intlLocale)
    : t('auto.components.automations.enablement.paused', 'Paused')
  const nextRunTitle = formatAutomationDateTime(automation.nextRunAt, t, intlLocale)
  const isSelected = isSelectedLocal && selectedRowKey === row.key
  const movedToDistro = useAppStore(
    (state) => wslMovedProjectForAutomation(state.wslMovedProjects, automation)?.distro ?? null
  )
  const agentLabel = automation.bot
    ? botAgentLabel(automation.agentId)
    : getAgentLabel(automation.agentId)
  const hostLabel = automationRowHostLabel(row, automationRepo, hostLabelById)
  const agentTooltipLabel = `${agentLabel} · ${hostLabel} · ${formatAutomationUsageSummary(row.usageSummary ?? undefined, t, intlLocale)}`
  const canRunNow = automationRunAvailability.canRunNow && allows(row, 'run')
  const lastRun = lastRunByAutomationId.get(automation.id)
  // Use the projected newest retained run when history is absent; the list does not download history.
  const lastRunSnapshot = lastRun
    ? getLocalAutomationLastRunSnapshot(automation, lastRun, t)
    : getAutomationRowLastRunSnapshot(row, t)

  const setupReview = pendingAutomationSetupReviewFromSummary(automation, row.usageSummary)
  const reviewContent = onReviewSetup && allows(row, 'save') ? setupReview?.content : null
  const reviewSetupLabel = t('automations.setupTrust.reviewAction', 'Review setup')

  const copyUrl = automationWebhookUrlCopy(automation, bots)
  const copyUrlLabel = t('bots.webhooks.copyUrl', 'Copy URL')

  const dropdownRunItem = (
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
          ? t('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')
          : automationRunAvailability.message}
      </span>
    </DropdownMenuItem>
  )

  const actionItems = (
    <>
      <MenuRunItem
        disabled={!canRunNow}
        disabledReason={
          automationRunAvailability.canRunNow ? undefined : automationRunAvailability.message
        }
        label={
          automationRunAvailability.canRunNow
            ? t('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')
            : automationRunAvailability.message
        }
        onSelect={() => onRunNow(row)}
      />
      <MenuItem
        disabled={!allows(row, 'edit')}
        icon={<Pencil className="size-3.5" />}
        label={t('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
        onSelect={() => onEdit(row)}
      />
      {copyUrl ? (
        <MenuItem icon={<Link className="size-3.5" />} label={copyUrlLabel} onSelect={copyUrl} />
      ) : null}
      <MenuItem
        disabled={!allows(row, 'toggle')}
        icon={automation.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        label={
          automation.enabled
            ? t('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
            : t('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')
        }
        onSelect={() => onToggle(row)}
      />
      {reviewContent ? (
        <MenuItem
          icon={<ShieldCheck className="size-3.5" />}
          label={reviewSetupLabel}
          onSelect={() => onReviewSetup?.(row, reviewContent)}
        />
      ) : null}
      <MenuSeparator />
      <MenuItem
        disabled={!allows(row, 'delete')}
        icon={<Trash2 className="size-3.5" />}
        label={t('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
        variant="destructive"
        onSelect={() => onDelete(row)}
      />
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-automation-row-id={row.key}
          data-current={isSelected ? 'true' : undefined}
          aria-label={`${automation.name}, ${scheduleLabel}`}
          onClick={(event) => {
            // React bubbles portaled menu clicks through this row; ignore them to avoid opening detail.
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
            automationsTableGridClass(showHost),
            LIST_TABLE_ROW_CLASS,
            isSelected && LIST_TABLE_ROW_SELECTED_CLASS
          )}
        >
          <span className={cn(LIST_TABLE_STICKY_ROW_CELL_CLASS, 'gap-2.5')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex shrink-0 items-center" aria-label={agentTooltipLabel}>
                  <AgentIcon agent={automation.agentId} size={16} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {agentTooltipLabel}
              </TooltipContent>
            </Tooltip>
            <span className="flex min-w-0 flex-col">
              <span className="min-w-0 truncate font-medium">{automation.name}</span>
              <AutomationWontFireMark automation={automation} bots={bots} />
              <span
                className="min-w-0 truncate text-xs text-muted-foreground"
                title={scheduleLabel}
              >
                {scheduleLabel}
              </span>
            </span>
          </span>
          <span className="min-w-0 truncate text-muted-foreground" title={projectLabel}>
            {projectLabel}
          </span>
          {showHost ? (
            <span className="min-w-0 truncate text-muted-foreground" title={hostLabel}>
              {hostLabel}
            </span>
          ) : null}
          <AutomationListNextRunCell
            enabled={automation.enabled}
            nextRunLabel={nextRunLabel}
            nextRunTitle={nextRunTitle}
            movedToDistro={movedToDistro}
            needsMigration={needsMigration?.(row)}
            setupSkipped={Boolean(setupReview)}
          />
          <AutomationListLastRunCell snapshot={lastRunSnapshot} now={relativeNow} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-7 text-muted-foreground"
                aria-label={t(
                  'auto.components.automations.AutomationListLocalRows.c92c9463c6',
                  'Automation actions'
                )}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {automationRunAvailability.canRunNow ? (
                dropdownRunItem
              ) : (
                <div title={automationRunAvailability.message}>{dropdownRunItem}</div>
              )}
              <DropdownMenuItem disabled={!allows(row, 'edit')} onSelect={() => onEdit(row)}>
                <Pencil className="size-3.5" />
                {t('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
              </DropdownMenuItem>
              {copyUrl ? (
                <DropdownMenuItem onSelect={copyUrl}>
                  <Link className="size-3.5" />
                  {copyUrlLabel}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={!allows(row, 'toggle')} onSelect={() => onToggle(row)}>
                {automation.enabled ? (
                  <Pause className="size-3.5" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {automation.enabled
                  ? t('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
                  : t('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')}
              </DropdownMenuItem>
              {reviewContent ? (
                <DropdownMenuItem onSelect={() => onReviewSetup?.(row, reviewContent)}>
                  <ShieldCheck className="size-3.5" />
                  {reviewSetupLabel}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={!allows(row, 'delete')}
                onSelect={() => onDelete(row)}
              >
                <Trash2 className="size-3.5" />
                {t('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">{actionItems}</ContextMenuContent>
    </ContextMenu>
  )
}
