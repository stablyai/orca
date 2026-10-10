import type { ExecutionHostId } from '../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { buildSidebarHostOptions } from './sidebar/sidebar-host-options'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import {
  restartMachineExecutionHostId,
  restartMachineTarget,
  type RestartMachineKey
} from './native-chat-restart-machines'

type HostLabelSources = Pick<
  AppState,
  | 'repos'
  | 'sshTargetLabels'
  | 'sshConnectionStates'
  | 'settings'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
>

let cached: { sources: HostLabelSources; labels: ReadonlyMap<ExecutionHostId, string> } | null =
  null

/** The sidebar's host names, built as `useSidebarHostScopeOptions` builds them; rebuilt only when an
 *  input changes, since store selectors call this on every store update. */
function sidebarHostLabels(state: HostLabelSources): ReadonlyMap<ExecutionHostId, string> {
  const previous = cached?.sources
  if (
    cached &&
    previous?.repos === state.repos &&
    previous.sshTargetLabels === state.sshTargetLabels &&
    previous.sshConnectionStates === state.sshConnectionStates &&
    previous.settings === state.settings &&
    previous.runtimeEnvironments === state.runtimeEnvironments &&
    previous.runtimeStatusByEnvironmentId === state.runtimeStatusByEnvironmentId
  ) {
    return cached.labels
  }
  const hosts = buildSidebarHostOptions({
    repos: state.repos,
    sshTargetLabels: state.sshTargetLabels,
    sshConnectionStates: state.sshConnectionStates,
    settings: state.settings,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
    hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
  })
  const labels = new Map(hosts.map((host) => [host.id, host.label]))
  cached = {
    sources: {
      repos: state.repos,
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      settings: state.settings,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
    },
    labels
  }
  return labels
}

/** What the user calls a machine: the sidebar's own name for its host (a paired server's name, this
 *  computer's label, either renamed in host settings), so a machine row and a workspace's host chip
 *  never spell one host two ways. */
export function restartMachineNameFromState(
  state: HostLabelSources,
  machine: RestartMachineKey
): string {
  const target = restartMachineTarget(machine)
  const hostId = restartMachineExecutionHostId(target)
  return (
    sidebarHostLabels(state).get(hostId) ??
    (target.kind === 'environment' ? target.environmentId : hostId)
  )
}

export function restartMachineName(machine: RestartMachineKey): string {
  return restartMachineNameFromState(useAppStore.getState(), machine)
}
