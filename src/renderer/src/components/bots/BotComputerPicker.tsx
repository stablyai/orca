// New bot's Computer field: ready computers first, then the rest with their fix (Reconnect, Update).
import React, { useEffect, useState } from 'react'
import { noHostsMatchLabel } from '@/components/host-picker/host-picker-copy'
import RunTargetCombobox from '@/components/new-workspace/run-target/RunTargetCombobox'
import type { RunTargetHostOption } from '@/components/new-workspace/run-target/run-target-options'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/host-connections/runtime-environment-explicit-connect'
import type { Translate } from '@/i18n/use-translate'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { botCreateHostRows, type BotCreateHostAction } from './bot-create-host-rows'
import { useServerUpdatable, type BotCreateHostChoice } from './bot-create-hosts'

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

export function BotComputerPicker({
  hostChoice,
  onAddHost
}: {
  hostChoice: BotCreateHostChoice
  onAddHost?: (mode: 'ssh' | 'server') => void
}): React.JSX.Element {
  const t = useTranslate()
  const { host, hosts } = hostChoice
  const remoteServerUpdates = useAppStore((s) => s.remoteServerUpdates)
  const setUpdateDialogOpen = useAppStore((s) => s.setRemoteServerUpdateDialogOpen)
  const updatable = useServerUpdatable()
  const [readyAtOpen, setReadyAtOpen] = useState<ReadonlySet<ExecutionHostId> | null>(null)
  // Only an open list reads servers' accounts and update state (both go over the network); its rows are
  // built from what is already known, closed too, so a key that opens it arms the row it will show.
  const listOpen = readyAtOpen !== null
  const [reconnecting, setReconnecting] = useState<ReadonlySet<string>>(new Set())
  const refreshUpdates = useAppStore((s) => s.refreshRemoteServerUpdates)
  const { setListing } = hostChoice
  useEffect(() => {
    setListing(listOpen)
    return () => setListing(false)
  }, [listOpen, setListing])
  // The update check asks every server, so it waits for the list, as it did behind New bot's Change.
  const needsUpdateCheck =
    listOpen &&
    hosts.some(
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
  const options = rows.map((row): RunTargetHostOption => {
    const { host: rowHost, action } = row
    const environmentId = rowHost.environmentId
    const onSelect = !rowHost.blocked
      ? () => hostChoice.setHostId(rowHost.hostId)
      : action === 'reconnect' && environmentId
        ? () => reconnect(environmentId)
        : action === 'update'
          ? () => setUpdateDialogOpen(true)
          : undefined
    return {
      id: rowHost.hostId,
      hostId: rowHost.hostId,
      label: rowHost.label,
      detail: action === 'reconnecting' ? actionLabel(action, t) : (row.meta ?? row.hint ?? ''),
      description: row.meta ? (row.hint ?? undefined) : undefined,
      group: row.group,
      available: !rowHost.blocked,
      onSelect,
      keepOpen: action === 'reconnect',
      trailing:
        action && action !== 'reconnecting'
          ? () => <span className="shrink-0 text-xs font-medium">{actionLabel(action, t)}</span>
          : undefined
    }
  })

  return (
    <RunTargetCombobox
      selectedHostId={host.hostId}
      fieldName={t('bots.new.computer', 'Computer')}
      emptyMessage={noHostsMatchLabel(t)}
      onOpenChange={(open) =>
        setReadyAtOpen(
          open
            ? new Set(hosts.filter((entry) => !entry.blocked).map((entry) => entry.hostId))
            : null
        )
      }
      hostOptions={options}
      onAddSshHost={onAddHost ? () => onAddHost('ssh') : undefined}
      onAddRemoteServer={onAddHost ? () => onAddHost('server') : undefined}
      truncateMiddle
    />
  )
}
