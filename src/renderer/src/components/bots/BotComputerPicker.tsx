// New bot's Computer field: ready computers first, then the rest with their fix (Reconnect, Update).
import React, { useEffect, useState } from 'react'
import { HostCombobox, type HostComboboxOption } from '@/components/host-picker/HostCombobox'
import { HostRowIcon } from '@/components/host-picker/host-row-icon'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/host-connections/runtime-environment-explicit-connect'
import type { Translate } from '@/i18n/use-translate'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  botCreateHostRows,
  type BotCreateHostAction,
  type BotCreateHostRow
} from './bot-create-host-rows'
import { useServerUpdatable, type BotCreateHostChoice } from './bot-create-hosts'

// Search earns its row only once the list is long.
const SEARCH_FROM_ROWS = 8

function actionLabel(action: BotCreateHostAction, t: Translate): string {
  switch (action) {
    case 'reconnect':
      return t('bots.new.hostReconnect', 'Reconnect')
    case 'reconnecting':
      return t('bots.new.hostReconnecting', 'Reconnecting…')
    case 'update':
      return t('bots.new.hostUpdateAction', 'Update')
  }
}

function rowContent(row: BotCreateHostRow, t: Translate): React.ReactNode {
  const { host, meta, action } = row
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <HostRowIcon hostId={host.hostId} />
      <span className={cn('min-w-0 truncate', host.blocked && action && 'text-muted-foreground')}>
        {host.label}
      </span>
      <span className="min-w-2 flex-1" />
      {meta ? (
        // Shrinks well before the name does.
        <span className="min-w-0 shrink-[100] truncate text-muted-foreground">{meta}</span>
      ) : null}
      {action ? (
        <span
          className={cn(
            'shrink-0',
            action === 'reconnecting' ? 'text-muted-foreground' : 'font-medium text-foreground'
          )}
        >
          {actionLabel(action, t)}
        </span>
      ) : null}
    </span>
  )
}

export function BotComputerPicker({
  hostChoice
}: {
  hostChoice: BotCreateHostChoice
}): React.JSX.Element {
  const t = useTranslate()
  const { host, hosts } = hostChoice
  const remoteServerUpdates = useAppStore((s) => s.remoteServerUpdates)
  const setUpdateDialogOpen = useAppStore((s) => s.setRemoteServerUpdateDialogOpen)
  const updatable = useServerUpdatable()
  const [readyAtOpen, setReadyAtOpen] = useState<ReadonlySet<ExecutionHostId> | null>(null)
  const [reconnecting, setReconnecting] = useState<ReadonlySet<string>>(new Set())
  const refreshUpdates = useAppStore((s) => s.refreshRemoteServerUpdates)
  const { setListing } = hostChoice
  // Mounted while Change is open, so accounts are read before the list opens and nothing pops in.
  useEffect(() => {
    setListing(true)
    return () => setListing(false)
  }, [setListing])
  const needsUpdateCheck = hosts.some(
    (entry) =>
      entry.blocked === 'no-bots' &&
      entry.environmentId &&
      !remoteServerUpdates.has(entry.environmentId)
  )
  useEffect(() => {
    if (needsUpdateCheck) {
      void refreshUpdates()
    }
  }, [needsUpdateCheck, refreshUpdates])

  const reconnect = (environmentId: string): void => {
    setReconnecting((previous) => new Set(previous).add(environmentId))
    void connectRuntimeHostAndReloadProjects(environmentId).finally(() =>
      setReconnecting((previous) => {
        const next = new Set(previous)
        next.delete(environmentId)
        return next
      })
    )
  }

  const rows = botCreateHostRows(
    hosts,
    {
      readyAtOpen,
      otherAccountOf: hostChoice.otherAccountOf,
      updatable,
      reconnecting
    },
    t
  )
  const grouped =
    rows.some((row) => row.group === 'ready') && rows.some((row) => row.group === 'unavailable')
  const options = rows.map((row): HostComboboxOption => {
    const { host: rowHost, action } = row
    const environmentId = rowHost.environmentId
    const onSelect =
      action === 'reconnect' && environmentId
        ? () => reconnect(environmentId)
        : action === 'update'
          ? () => setUpdateDialogOpen(true)
          : undefined
    return {
      id: rowHost.hostId,
      label: rowHost.label,
      content: rowContent(row, t),
      triggerContent: (
        <span className="flex min-w-0 items-center gap-2">
          <HostRowIcon hostId={rowHost.hostId} />
          <span className="min-w-0 truncate">{rowHost.label}</span>
        </span>
      ),
      ...(grouped
        ? {
            group:
              row.group === 'ready'
                ? t('bots.new.hostsReady', 'Ready')
                : t('bots.new.hostsUnavailable', 'Not available')
          }
        : {}),
      // A row with no fix is only there to say the computer exists.
      disabled: Boolean(rowHost.blocked) && !onSelect,
      ...(row.hint
        ? {
            description:
              action === 'reconnect'
                ? t('bots.new.hostHintAction', '{{hint}}. {{action}}', {
                    hint: row.hint,
                    action: actionLabel(action, t)
                  })
                : row.hint
          }
        : {}),
      ...(rowHost.blocked && onSelect ? { onSelect, keepOpen: action === 'reconnect' } : {})
    }
  })

  return (
    <HostCombobox
      value={host.hostId}
      onChange={(id) => {
        const picked = hosts.find((entry) => entry.hostId === id)
        if (picked) {
          hostChoice.setHostId(picked.hostId)
        }
      }}
      onOpenChange={(open) =>
        setReadyAtOpen(
          open
            ? new Set(hosts.filter((entry) => !entry.blocked).map((entry) => entry.hostId))
            : null
        )
      }
      options={options}
      searchFrom={SEARCH_FROM_ROWS}
      searchPlaceholder={t('bots.new.searchComputers', 'Search computers…')}
      reserveCheck
      size="sm"
      className="w-full"
    />
  )
}
