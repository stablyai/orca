import { useAppStateValueWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getWindowsTerminalCapabilityOwnerKey } from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'

type RuntimeCapabilityOwnerStatus = {
  connectionGeneration?: number
}

type RuntimeCapabilityOwnerEnvironment = Pick<
  PublicKnownRuntimeEnvironment,
  'id' | 'createdAt' | 'pairingRevision'
>

export function resolveWindowsTerminalCapabilityOwnerKey(args: {
  activeRuntimeEnvironmentId?: string | null
  isWebClient: boolean
  runtimeEnvironments: readonly RuntimeCapabilityOwnerEnvironment[]
  runtimeStatusByEnvironmentId?: ReadonlyMap<string, RuntimeCapabilityOwnerStatus>
  sshConnectionId?: string | null
}): string {
  const activeEnvironmentId = args.activeRuntimeEnvironmentId?.trim() || null
  const environment = args.isWebClient ? (args.runtimeEnvironments[0] ?? null) : null
  const ownerKey = getWindowsTerminalCapabilityOwnerKey(
    environment?.id ?? activeEnvironmentId,
    args.sshConnectionId
  )
  if (!environment) {
    return ownerKey
  }
  const pairingRevision = environment.pairingRevision ?? environment.createdAt
  const connectionGeneration =
    args.runtimeStatusByEnvironmentId?.get(environment.id)?.connectionGeneration ?? 0
  return `${ownerKey}:pairing:${pairingRevision}:connection:${connectionGeneration}`
}

export function useWindowsTerminalCapabilityOwnerKey(
  activeRuntimeEnvironmentId?: string | null,
  sshConnectionId?: string | null
): string {
  const isWebClient = isWebClientLocation()
  return useAppStateValueWithHostStatuses((state, statuses) =>
    resolveWindowsTerminalCapabilityOwnerKey({
      activeRuntimeEnvironmentId,
      isWebClient,
      runtimeEnvironments: state.runtimeEnvironments ?? [],
      runtimeStatusByEnvironmentId: statuses,
      sshConnectionId
    })
  )
}
