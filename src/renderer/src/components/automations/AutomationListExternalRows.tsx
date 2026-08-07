import React from 'react'
import { Clock, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import {
  formatExternalDate,
  getExternalProviderLabel,
  getExternalTargetKindLabel
} from './external-automation-display'
import { getExternalAutomationScheduleDisplay } from './external-automation-schedule-display'
import {
  getExternalAutomationActionDisabledMessage,
  getExternalAutomationSourceAvailability
} from './external-automation-source-availability'
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
    action: ExternalAutomationAction
  ) => void
  onEdit: (manager: ExternalAutomationManager, job: ExternalAutomationJob) => void
}): React.JSX.Element {
  return (
    <>
      {entries.map((entry) => {
        const providerLabel = getExternalProviderLabel(entry.manager)
        const targetKindLabel = getExternalTargetKindLabel(entry.manager)
        if (entry.kind === 'source') {
          const sshStatus =
            entry.manager.target.type === 'ssh'
              ? sshConnectionStates.get(entry.manager.target.connectionId)?.status
              : undefined
          const sourceAvailability = getExternalAutomationSourceAvailability({
            manager: entry.manager,
            providerLabel,
            targetKindLabel,
            sshStatus
          })
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => onSelect(entry.key)}
              className={cn(
                'mb-1 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                selectedExternalKey === entry.key
                  ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
                  : 'border-transparent hover:bg-muted/50'
              )}
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-2 rounded-full bg-muted-foreground/40" />
                  <span className="truncate font-medium">{entry.manager.targetLabel}</span>
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span>
                    {providerLabel}{' '}
                    {translate('auto.components.automations.AutomationsPage.82eb6cb933', 'source')}
                  </span>
                  <span className="shrink-0">/</span>
                  <span className="truncate">{targetKindLabel}</span>
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {sourceAvailability.summary}
                </span>
              </span>
              <span className="flex max-w-28 flex-col items-end gap-1 text-right text-xs text-muted-foreground">
                <Clock className="size-3.5" />
                <span className="line-clamp-2">{sourceAvailability.statusLabel}</span>
              </span>
            </button>
          )
        }
        const nextRunLabel = entry.job.enabled
          ? formatExternalDate(entry.job.nextRunAt, relativeNow)
          : translate('auto.components.automations.AutomationsPage.paused', 'Paused')
        const entrySshStatus =
          entry.manager.target.type === 'ssh'
            ? sshConnectionStates.get(entry.manager.target.connectionId)?.status
            : undefined
        const disabledMessage = getExternalAutomationActionDisabledMessage({
          manager: entry.manager,
          providerLabel,
          targetKindLabel,
          sshStatus: entrySshStatus,
          actionInProgress: externalActionKey !== null
        })
        const actionDisabled = disabledMessage !== null
        const scheduleDisplay = getExternalAutomationScheduleDisplay(entry.manager, entry.job)
        return (
          <ContextMenu key={entry.key}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(entry.key)}
                className={cn(
                  'mb-1 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                  selectedExternalKey === entry.key
                    ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
                    : 'border-transparent hover:bg-muted/50'
                )}
              >
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        entry.job.enabled ? 'bg-foreground' : 'bg-muted-foreground/40'
                      )}
                    />
                    <span className="truncate font-medium">{entry.job.name}</span>
                  </span>
                  <span className="mt-1 block truncate text-xs font-medium text-foreground/80">
                    {scheduleDisplay.label}
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {providerLabel} / {entry.manager.targetLabel}
                    </span>
                    <span className="shrink-0">·</span>
                    <span className="truncate">
                      {entry.manager.provider === 'hermes'
                        ? translate(
                            'auto.components.automations.AutomationsPage.runCount',
                            '{{count}} runs',
                            { count: entry.job.runCount }
                          )
                        : entry.manager.canManage
                          ? translate(
                              'auto.components.automations.AutomationsPage.aecdc3681f',
                              'Manageable'
                            )
                          : translate(
                              'auto.components.automations.AutomationsPage.e059042585',
                              'Read-only'
                            )}
                    </span>
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
                disabled={actionDisabled}
                onSelect={() => onRequestAction(entry.manager, entry.job, 'run')}
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
                  onSelect={() => onEdit(entry.manager, entry.job)}
                >
                  <Pencil className="size-3.5" />
                  {translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem
                disabled={actionDisabled}
                onSelect={() =>
                  onRequestAction(entry.manager, entry.job, entry.job.enabled ? 'pause' : 'resume')
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
                onSelect={() => onRequestAction(entry.manager, entry.job, 'delete')}
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
