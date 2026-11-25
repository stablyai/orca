import { useState } from 'react'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption
} from '@/lib/workspace/creation/project-host-setup-options'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import RunTargetCombobox from './RunTargetCombobox'
import { ConnectHostButton, NeedsSetupHostIcon, SetLocationButton } from './RunTargetRowActions'
import type { EphemeralVmRecipeOption, RunTargetHostOption } from './run-target-options'
import type { WslHostDistro } from '../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

export default function WorkspaceRunTargetCombobox({
  hostOptions,
  hostValue,
  hostExecutionHostId,
  onHostChange,
  onConnectHost,
  onSetLocation,
  ...picker
}: {
  hostOptions: readonly ProjectHostSetupOption[]
  hostValue: string | null
  hostExecutionHostId?: ExecutionHostId | null
  onHostChange?: (setupId: string) => void
  onConnectHost?: (option: NeedsSetupProjectHostOption) => Promise<void> | void
  onSetLocation?: (option: NeedsSetupProjectHostOption) => void
  recipes: readonly EphemeralVmRecipeOption[]
  recipeValue: string | null
  onRecipeChange?: (recipeId: string | null) => void
  onAddRemoteServer?: () => void
  onAddSshHost?: () => void
  onAddWslDistro?: (distro: WslHostDistro) => void
}): React.JSX.Element {
  const [connectingHosts, setConnectingHosts] = useState<ReadonlySet<ExecutionHostId>>(
    () => new Set()
  )
  const isSelected = (option: { id: string; hostId: ExecutionHostId }): boolean =>
    option.id === hostValue && (!hostExecutionHostId || option.hostId === hostExecutionHostId)
  const ready = hostOptions.filter((option) => option.kind === 'ready')
  const selected =
    ready.find(isSelected) ?? ready.find((option) => option.aliasSetups?.some(isSelected))

  const connectHost = async (option: NeedsSetupProjectHostOption): Promise<void> => {
    if (!onConnectHost || connectingHosts.has(option.hostId)) {
      return
    }
    setConnectingHosts((current) => new Set(current).add(option.hostId))
    await Promise.resolve()
      .then(() => onConnectHost(option))
      .finally(() => {
        setConnectingHosts((current) => {
          const next = new Set(current)
          next.delete(option.hostId)
          return next
        })
      })
  }

  const options = hostOptions.map((option): RunTargetHostOption => {
    const id = getProjectHostSetupSelectionKey(option)
    const { hostId, label } = option
    if (option.kind === 'ready') {
      return {
        id,
        hostId,
        label,
        detail: option.path,
        searchText: option.detail,
        available: true,
        onSelect: () => onHostChange?.(id)
      }
    }
    const connecting = connectingHosts.has(hostId)
    const connect = Boolean(option.connectAction && onConnectHost)
    const setLocation = option.canSetLocation && onSetLocation
    return {
      id,
      hostId,
      label,
      detail: connect || setLocation ? '' : option.detail,
      searchText: option.detail,
      available: false,
      icon: (
        <NeedsSetupHostIcon hostId={hostId} connecting={connecting} attention={option.attention} />
      ),
      onSelect: setLocation ? () => setLocation(option) : undefined,
      trailing: connect
        ? () => (
            <ConnectHostButton connecting={connecting} onConnect={() => void connectHost(option)} />
          )
        : setLocation
          ? (select) => <SetLocationButton hostLabel={label} onSetLocation={select} />
          : undefined
    }
  })

  return (
    <RunTargetCombobox
      {...picker}
      hostOptions={options}
      selectedHostId={selected ? getProjectHostSetupSelectionKey(selected) : null}
    />
  )
}
