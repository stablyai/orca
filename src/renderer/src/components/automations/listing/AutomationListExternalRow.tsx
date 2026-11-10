import React from 'react'
import { MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
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
} from '../../../../../shared/automations/external/external-automation'
import type { SshConnectionState } from '../../../../../shared/ssh-types'
import type { ExternalAutomationListEntry } from '../external/external-automation-list-entries'
import type { ExternalAutomationScope } from '../external/external-automation-scope-client'
import {
  formatExternalDate,
  getExternalProviderLabel,
  getExternalTargetKindLabel
} from '../external/external-automation-display'
import { getExternalAutomationScheduleDisplay } from '../external/external-automation-schedule-display'
import { getExternalAutomationActionDisabledMessage } from '../external/external-automation-source-availability'
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
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

export type AutomationListExternalRowProps = {
  entry: ExternalAutomationListEntry
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
}

export function AutomationListExternalRow({
  entry,
  selectedExternalKey,
  relativeNow,
  sshConnectionStates,
  externalActionKey,
  onSelect,
  onRequestAction
}: AutomationListExternalRowProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const providerLabel = getExternalProviderLabel(entry.manager)
  const isSelected = selectedExternalKey === entry.key
  const sshStatus =
    entry.manager.target.type === 'ssh'
      ? sshConnectionStates.get(entry.manager.target.connectionId)?.status
      : undefined
  const disabledMessage = getExternalAutomationActionDisabledMessage(
    {
      manager: entry.manager,
      providerLabel,
      sshStatus,
      actionInProgress: externalActionKey !== null
    },
    t
  )
  const actionDisabled = disabledMessage !== null
  const scheduleLabel = getExternalAutomationScheduleDisplay(
    entry.manager,
    entry.job,
    t,
    intlLocale
  ).label
  const hostLabel =
    entry.manager.targetLabel || entry.manager.label || getExternalTargetKindLabel(entry.manager, t)
  const projectLabel = entry.job.workdir ?? providerLabel
  const nextRunLabel = entry.job.enabled
    ? formatExternalDate(entry.job.nextRunAt, relativeNow, t, intlLocale)
    : t('auto.components.automations.AutomationsPage.paused', 'Paused')
  const lastRunSnapshot = getExternalAutomationLastRunSnapshot(entry.job, t)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-current={isSelected ? 'true' : undefined}
          onClick={(event) => {
            // React bubbles portaled menu clicks through this row; ignore them to avoid opening detail.
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
                aria-label={t(
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
                    t('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')}
                </span>
              </DropdownMenuItem>
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
                {entry.job.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {entry.job.enabled
                  ? t('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
                  : t('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={actionDisabled}
                onSelect={() => onRequestAction(entry.manager, entry.job, 'delete', entry.scope)}
              >
                <Trash2 className="size-3.5" />
                {t('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
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
              t('auto.components.automations.AutomationsPage.2faecab10b', 'Run Now')}
          </span>
        </ContextMenuItem>
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
            ? t('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
            : t('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          disabled={actionDisabled}
          onSelect={() => onRequestAction(entry.manager, entry.job, 'delete', entry.scope)}
        >
          <Trash2 className="size-3.5" />
          {t('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
