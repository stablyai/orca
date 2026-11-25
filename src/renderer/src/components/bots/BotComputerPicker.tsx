// New bot's Computer field: ready computers first, then the rest with their fix (Reconnect, Update).
import React, { useEffect, useState } from 'react'
import { noHostsMatchLabel } from '@/components/host-picker/host-picker-copy'
import RunTargetCombobox from '@/components/new-workspace/run-target/RunTargetCombobox'
import type { RunTargetHostOption } from '@/components/new-workspace/run-target/run-target-options'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/host-connections/runtime-environment-explicit-connect'
import type { Translate } from '@/i18n/use-translate'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { botCreateHostRows, type BotCreateHostAction } from './bot-create-host-rows'
import { useServerUpdatable, type BotCreateHostChoice } from './bot-create-hosts'
import { LinuxPenguinIcon } from '@/components/icons/LinuxPenguinIcon'
import { selectWslHostDistro } from '@/components/wsl-host-mark/WslHostMark'
import { startWslHostAndReloadProjects } from '@/runtime/hosts/wsl/wsl-host-user-start'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { wslHostEnvironmentLabel } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

const PENGUIN = <LinuxPenguinIcon className="size-3.5 shrink-0 text-muted-foreground" />
/** The row a distro shows as while it is set up, before it is a host. */
const SETTING_UP_ID = 'wsl-setup'

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
  onAddHost,
  errorId
}: {
  hostChoice: BotCreateHostChoice
  onAddHost?: (mode: 'ssh' | 'server') => void
  errorId?: string
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
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const { setListing, wslSetup } = hostChoice
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
      ? () => {
          hostChoice.setHostId(rowHost.hostId)
          // Picking a sleeping host is the user using it: wake it now, not at Create.
          if (rowHost.sleeping && environmentId) {
            void startWslHostAndReloadProjects(environmentId)
          }
        }
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
      icon: selectWslHostDistro({ runtimeEnvironments }, rowHost.hostId) ? PENGUIN : undefined,
      onSelect,
      keepOpen: action === 'reconnect',
      trailing:
        action && action !== 'reconnecting'
          ? () => <span className="shrink-0 text-xs font-medium">{actionLabel(action, t)}</span>
          : undefined
    }
  })

  const setup = wslSetup.state
  // Until the add makes it a host, the distro stands in for the pick so the field shows it at once.
  const settingUp = setup.phase === 'running' || setup.phase === 'failed' ? setup.distro : null
  if (settingUp) {
    options.unshift({
      id: SETTING_UP_ID,
      hostId: LOCAL_EXECUTION_HOST_ID,
      label: wslHostEnvironmentLabel(settingUp.name),
      detail:
        setup.phase === 'failed'
          ? t('bots.new.wslSetupFailedShort', 'Setup didn’t finish')
          : t('bots.new.wslSettingUp', 'Setting up…'),
      available: true,
      icon: PENGUIN
    })
  }
  const selectedId = settingUp ? SETTING_UP_ID : host.hostId

  return (
    <RunTargetCombobox
      selectedHostId={selectedId}
      fieldName={t('bots.new.computer', 'Computer')}
      errorId={errorId}
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
      onAddWslDistro={onAddHost ? wslSetup.start : undefined}
      truncateMiddle
    />
  )
}
