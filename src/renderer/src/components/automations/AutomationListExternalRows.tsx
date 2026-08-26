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
import { cn } from '@/lib/utils'
import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import {
  formatExternalDate,
  getExternalProviderLabel,
  getExternalTargetKindLabel
} from './external-automation-display'
import { getExternalAutomationScheduleDisplay } from './external-automation-schedule-display'
import { getExternalAutomationActionDisabledMessage } from './external-automation-source-availability'
import { AUTOMATIONS_TABLE_GRID_CLASS } from './automations-table-layout'
import {
  LIST_TABLE_ROW_CLASS,
  LIST_TABLE_ROW_SELECTED_CLASS,
  LIST_TABLE_STICKY_ROW_CELL_CLASS
} from '@/lib/list-table-layout'
import { isPortaledRowMenuClick, isRowActivationKey } from '@/lib/list-row-interaction'
import { getExternalAutomationLastRunSnapshot } from './automation-list-last-run'
import { AutomationListLastRunCell } from './AutomationListLastRunCell'
import { AutomationListStatusCell } from './AutomationListStatusCell'
import { translate } from '@/i18n/i18n'

export function AutomationListExternalRows({
  entries,
  selectedExternalKey,
  relativeNow,
  sshConnectionStates,
  externalActionKey,
  onSelect,
  onRequestAction,
  onEdit
}: {
  entries: readonly ExternalAutomationListEntry[]
  selectedExternalKey: string | null | undefined
  relativeNow: number
  sshConnectionStates: ReadonlyMap<string, Pick<SshConnectionState, 'status'>>
  externalActionKey: string | null
  onSelect: (entryKey: string) => void
  onRequestAction: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction,
    scope: ExternalAutomationScope
  ) => void
  onEdit: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    scope: ExternalAutomationScope
  ) => void
}): React.JSX.Element {
  return (
    <>
      {entries.map((entry) => {
        const providerLabel = getExternalProviderLabel(entry.manager)
        const targetKindLabel = getExternalTargetKindLabel(entry.manager)
        const isSelected = selectedExternalKey === entry.key
        const sshStatus =
          entry.manager.target.type === 'ssh'
            ? sshConnectionStates.get(entry.manager.target.connectionId)?.status
            : undefined
        const disabledMessage = getExternalAutomationActionDisabledMessage({
          manager: entry.manager,
          providerLabel,
          targetKindLabel,
          sshStatus,
          actionInProgress: externalActionKey !== null
        })
        const actionDisabled = disabledMessage !== null
        const scheduleLabel = getExternalAutomationScheduleDisplay(entry.manager, entry.job).label
        const hostLabel = entry.manager.targetLabel || entry.manager.label || 'Local'
        const projectLabel = entry.job.workdir ?? providerLabel
        const nextRunLabel = entry.job.enabled
          ? formatExternalDate(entry.job.nextRunAt, relativeNow)
          : translate('auto.components.automations.AutomationsPage.paused', 'Paused')
        const lastRunSnapshot = getExternalAutomationLastRunSnapshot(entry.job)

        return (
          <ContextMenu key={entry.key}>
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
                  onSelect(entry.key)
                }}
                onKeyDown={(event) => {
                  if (!isRowActivationKey(event)) {
                    return
                  }
                  event.preventDefault()
                  onSelect(entry.key)
                }}
                className={cn(
                  AUTOMATIONS_TABLE_GRID_CLASS,
                  LIST_TABLE_ROW_CLASS,
                  isSelected && LIST_TABLE_ROW_SELECTED_CLASS
                )}
              >
                <span className={LIST_TABLE_STICKY_ROW_CELL_CLASS}>
                  <span className="min-w-0 truncate font-medium">{entry.job.name}</span>
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
                <AutomationListStatusCell enabled={entry.job.enabled} />
                <span className="truncate text-center text-xs text-muted-foreground">
                  {providerLabel}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-7 text-muted-foreground"
                      aria-label={translate(
                        'auto.components.automations.AutomationsPage.rowActions',
                        'Automation actions'
                      )}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem
                      disabled={actionDisabled}
                      onSelect={() => onRequestAction(entry.manager, entry.job, 'run', entry.scope)}
                    >
                      <Play className="size-3.5" />
                      <span className="min-w-0 truncate">
                        {disabledMessage ??
                          translate(
                            'auto.components.automations.AutomationsPage.2faecab10b',
                            'Run Now'
                          )}
                      </span>
                    </DropdownMenuItem>
                    {entry.manager.provider === 'hermes' ? (
                      <DropdownMenuItem
                        disabled={!entry.manager.canManage || externalActionKey !== null}
                        onSelect={() => onEdit(entry.manager, entry.job, entry.scope)}
                      >
                        <Pencil className="size-3.5" />
                        {translate(
                          'auto.components.automations.AutomationsPage.f4612e3f78',
                          'Edit'
                        )}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      disabled={actionDisabled}
                      onSelect={() =>
                        onRequestAction(
                          entry.manager,
                          entry.job,
                          entry.job.enabled ? 'pause' : 'resume',
                          entry.scope
                        )
                      }
                    >
                      {entry.job.enabled ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {entry.job.enabled
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
                      disabled={actionDisabled}
                      onSelect={() =>
                        onRequestAction(entry.manager, entry.job, 'delete', entry.scope)
                      }
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
            <ContextMenuContent className="w-48">
              <ContextMenuItem
                disabled={actionDisabled}
                onSelect={() => onRequestAction(entry.manager, entry.job, 'run', entry.scope)}
              >
                <Play className="size-3.5" />
                <span className="min-w-0 truncate">
                  {disabledMessage ??
                    translate('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')}
                </span>
              </ContextMenuItem>
              {entry.manager.provider === 'hermes' ? (
                <ContextMenuItem
                  disabled={!entry.manager.canManage || externalActionKey !== null}
                  onSelect={() => onEdit(entry.manager, entry.job, entry.scope)}
                >
                  <Pencil className="size-3.5" />
                  {translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem
                disabled={actionDisabled}
                onSelect={() =>
                  onRequestAction(
                    entry.manager,
                    entry.job,
                    entry.job.enabled ? 'pause' : 'resume',
                    entry.scope
                  )
                }
              >
                {entry.job.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {entry.job.enabled
                  ? translate('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
                  : translate('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                disabled={actionDisabled}
                onSelect={() => onRequestAction(entry.manager, entry.job, 'delete', entry.scope)}
              >
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
