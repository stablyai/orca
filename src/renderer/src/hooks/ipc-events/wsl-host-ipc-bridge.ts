import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { isWslHostRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { workspaceOwnerHostId } from '../../lib/workspace-row-owner-host'
import type { AppState } from '../../store/types'
import { useAppStore } from '../../store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

/** Report active and terminal-tab workspace hosts, each resolved from its own owner. */
export function selectWslHostsWithVisibleWork(state: AppState): string[] {
  const wslEnvironmentIds = new Set(
    state.runtimeEnvironments
      .filter(isWslHostRuntimeEnvironment)
      .map((environment) => environment.id)
  )
  if (wslEnvironmentIds.size === 0) {
    return []
  }
  const workspaceIds = new Set<string>()
  if (state.activeWorktreeId) {
    workspaceIds.add(state.activeWorktreeId)
  }
  for (const [workspaceId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.length > 0) {
      workspaceIds.add(workspaceId)
    }
  }
  const visible = new Set<string>()
  for (const workspaceId of workspaceIds) {
    const host = parseExecutionHostId(workspaceOwnerHostId(state, workspaceId))
    if (host?.kind === 'runtime' && wslEnvironmentIds.has(host.environmentId)) {
      visible.add(host.environmentId)
    }
  }
  return [...visible].sort()
}

/** Mirrors WSL host status into the store and tells main which hosts the user has open. */
export function registerWslHostIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.runtimeEnvironments?.wslHosts
  // An older preload, or a partial test bridge, lacks the WSL host namespace.
  if (typeof api?.onStatusChanged !== 'function') {
    return
  }
  const apply = (status: WslHostStatus): void => useAppStore.getState().applyWslHostStatus(status)
  // A preload from before the capability call leaves it unknown, which the UI treats as present.
  if (typeof api.getCapability === 'function') {
    void api
      .getCapability()
      .then(({ serverFiles }) => useAppStore.getState().setWslHostServerFiles(serverFiles))
      .catch((error) => console.error('Failed to read WSL host capability:', error))
  }
  let stopped = false
  unsubs.push(api.onStatusChanged(apply), () => {
    stopped = true
  })
  void api
    .getStatuses()
    .then((statuses) => {
      if (!stopped) {
        statuses.forEach(apply)
      }
    })
    .catch((error) => console.error('Failed to read WSL host statuses:', error))

  let reported = ''
  let inputs: readonly unknown[] = []
  const report = (state: AppState): void => {
    if (state.settings?.experimentalWslHosts !== true) {
      return
    }
    // Why: this runs on every store write; only these inputs can change the answer.
    const next = [
      state.activeWorktreeId,
      state.tabsByWorktree,
      state.runtimeEnvironments,
      state.repos,
      selectFolderWorkspaces(state),
      state.projectGroups
    ]
    if (next.every((value, index) => value === inputs[index])) {
      return
    }
    inputs = next
    const environmentIds = selectWslHostsWithVisibleWork(state)
    const key = environmentIds.join('\n')
    if (key === reported) {
      return
    }
    reported = key
    void api.setVisibleWork({ environmentIds }).catch((error) => {
      console.error('Failed to report open WSL host work:', error)
    })
  }
  report(useAppStore.getState())
  unsubs.push(useAppStore.subscribe(report))
}
