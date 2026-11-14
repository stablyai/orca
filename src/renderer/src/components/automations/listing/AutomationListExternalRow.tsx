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
import { cn } from '@/lib/class-names'
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
  getExternalProviderLabel
} from '../external/external-automation-display'
import { getExternalAutomationScheduleDisplay } from '../external/external-automation-schedule-display'
import { getExternalAutomationActionDisabledMessage } from '../external/external-automation-source-availability'
import { automationsTableGridClass } from './automations-table-layout'
import { externalAutomationHostLabel } from './automation-list-host'
import {
  LIST_TABLE_ROW_CLASS,
  LIST_TABLE_ROW_SELECTED_CLASS,
  LIST_TABLE_STICKY_ROW_CELL_CLASS
} from '@/lib/list-interaction/list-table-layout'
import {
  isPortaledRowMenuClick,
  isRowActivationKey
} from '@/lib/list-interaction/list-row-interaction'
import { getExternalAutomationLastRunSnapshot } from './automation-list-last-run'
import { AutomationListLastRunCell } from './AutomationListLastRunCell'
import { AutomationListNextRunCell } from './AutomationListNextRunCell'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'

export type AutomationListExternalRowProps = {
  entry: ExternalAutomationListEntry
  selectedExternalKey: string | null | undefined
  relativeNow: number
  sshConnectionStates: ReadonlyMap<string, Pick<SshConnectionState, 'status'>>
  externalActionKey: string | null
  /** The list spans more than one host. */
  showHost?: boolean
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
  showHost = false,
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
  const hostLabel = externalAutomationHostLabel(entry, t)
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
          data-automation-external-id={entry.key}
          data-current={isSelected ? 'true' : undefined}
          aria-label={[entry.job.name, scheduleLabel, showHost ? hostLabel : null]
            .filter(Boolean)
            .join(', ')}
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
            automationsTableGridClass(showHost),
            LIST_TABLE_ROW_CLASS,
            isSelected && LIST_TABLE_ROW_SELECTED_CLASS
          )}
        >
          <span className={cn(LIST_TABLE_STICKY_ROW_CELL_CLASS, 'gap-2.5')}>
            <span
              className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-3xs font-semibold text-muted-foreground"
              title={providerLabel}
              aria-hidden="true"
            >
              {providerLabel.slice(0, 1)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="min-w-0 truncate font-medium">{entry.job.name}</span>
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
          <AutomationListNextRunCell enabled={entry.job.enabled} nextRunLabel={nextRunLabel} />
          <AutomationListLastRunCell snapshot={lastRunSnapshot} now={relativeNow} />
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
