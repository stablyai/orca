import type { AppState } from '../../store/types'
import type { Translate } from '@/i18n/use-translate'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import {
  isOwnedSshTargetId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host/execution-host-registry'
import { pickerExecutionHosts } from '../../../../shared/execution-host/managed-orcad-execution-host'
import {
  isListedRemoteServer,
  runtimePairingRepairRoute
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { isConnectedRuntimeHostState } from '../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import {
  runtimeHostBlockedCopy,
  runtimeHostBlockedRecovery,
  runtimeHostStatusForOverall,
  sshStatusForOverall
} from './remote-host-connection-status'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

export function buildRemoteHostMenuInventory(
  {
    runtimeEnvironments,
    settings,
    sshTargetLabels,
    sshConnectionStates,
    runtimeStatusByEnvironmentId
  }: Pick<
    AppState,
    | 'runtimeEnvironments'
    | 'settings'
    | 'sshTargetLabels'
    | 'sshConnectionStates'
    | 'runtimeStatusByEnvironmentId'
  >,
  t: Translate
) {
  const hostLabelOverrides = getHostDisplayLabelOverrides(settings)
  const userManagedEnvironments = runtimeEnvironments.filter(isListedRemoteServer)
  // Why the registry: a managed server and its SSH host are one machine, shown on its active route.
  const visibleHosts = new Map(
    pickerExecutionHosts(
      buildExecutionHostRegistry({
        repos: [],
        settings,
        hostSource: 'configured-only',
        sshTargetLabels,
        sshConnectionStates,
        runtimeEnvironments: userManagedEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides
      })
    ).map((host) => [host.id, host])
  )
  const targets = Array.from(sshTargetLabels.entries())
    // Hide runtime-owned per-workspace SSH targets from the user-managed host list.
    .filter(([id]) => !isOwnedSshTargetId(id) && visibleHosts.has(toSshExecutionHostId(id)))
    .map(([id, label]) => {
      const state = sshConnectionStates.get(id)
      return {
        id,
        label: visibleHosts.get(toSshExecutionHostId(id))?.label || label,
        error: state?.error,
        reconnectAttempt: state?.reconnectAttempt,
        status: state?.status ?? ('disconnected' satisfies SshConnectionStatus)
      }
    })
  const runtimeHosts = userManagedEnvironments
    .filter((environment) => visibleHosts.has(toRuntimeExecutionHostId(environment.id)))
    .map((environment) => {
      const statusEntry = runtimeStatusByEnvironmentId.get(environment.id)
      const registryHost = visibleHosts.get(toRuntimeExecutionHostId(environment.id))
      // Why the registry's verdict: it is the same blocked reason the sidebar and Settings show.
      const blockedReason =
        registryHost?.health === 'blocked' ? registryHost.blockedReason : undefined
      const repairRoute = runtimePairingRepairRoute(environment)
      return {
        id: environment.id,
        label: registryHost?.label || environment.name || environment.id,
        blockedReason,
        blocked: blockedReason
          ? {
              ...runtimeHostBlockedCopy(blockedReason, registryHost?.compatibility, repairRoute, t),
              recovery: runtimeHostBlockedRecovery(blockedReason, repairRoute)
            }
          : null,
        snapshot: statusEntry?.snapshot,
        status: statusEntry?.status ?? null,
        active: settings?.activeRuntimeEnvironmentId === environment.id,
        remoteControl: statusEntry?.remoteControl ?? statusEntry?.status?.remoteControl ?? null
      }
    })
  const runtimeHostRows = runtimeHosts.map((host) => ({
    ...host,
    state: runtimeHostConnectionStateForEntry(runtimeStatusByEnvironmentId.get(host.id))
  }))
  // Host health is independent of active runtime selection; available remote servers remain online.
  const connectedRuntimeHosts = runtimeHostRows.filter((host) =>
    isConnectedRuntimeHostState(host.state)
  )
  const inactiveRuntimeHosts = runtimeHostRows.filter(
    (host) => !isConnectedRuntimeHostState(host.state)
  )
  const statuses = [
    ...targets.map((target) => sshStatusForOverall(target.status)),
    ...runtimeHostRows.map((host) => runtimeHostStatusForOverall(host.state, host.blockedReason))
  ]
  return {
    targets,
    runtimeHostRows,
    connectedRuntimeHosts,
    inactiveRuntimeHosts,
    connectedHostCount: statuses.filter((status) => status === 'connected').length,
    hostCount: statuses.length
  }
}
