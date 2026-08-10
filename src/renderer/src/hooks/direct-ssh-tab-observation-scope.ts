import type { AppState } from '../store/types'

export type DirectSshObservationScopeInputRefs = Pick<
  AppState,
  | 'sshTargetLabels'
  | 'remoteWorkspaceHydratedTargetIds'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export function configuredDirectSshTargetIds(state: AppState): Set<string> {
  return new Set([
    ...state.sshTargetLabels.keys(),
    ...state.sshConnectionStates.keys(),
    ...state.remoteWorkspaceHydratedTargetIds
  ])
}

export function directSshObservationScopeInputRefs(
  state: AppState
): DirectSshObservationScopeInputRefs {
  return {
    sshTargetLabels: state.sshTargetLabels,
    remoteWorkspaceHydratedTargetIds: state.remoteWorkspaceHydratedTargetIds,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }
}

export function directSshObservationScopeInputsEqual(
  previous: DirectSshObservationScopeInputRefs | null,
  next: DirectSshObservationScopeInputRefs
): boolean {
  return (
    previous !== null &&
    Object.keys(next).every(
      (key) =>
        previous[key as keyof DirectSshObservationScopeInputRefs] ===
        next[key as keyof DirectSshObservationScopeInputRefs]
    )
  )
}

export function directSshConnectednessTransitionTargetIds(
  previous: AppState['sshConnectionStates'],
  next: AppState['sshConnectionStates'],
  scopedTargetIds: Pick<ReadonlySet<string>, 'has'>
): string[] {
  const changed: string[] = []
  for (const targetId of new Set([...previous.keys(), ...next.keys()])) {
    const wasConnected = previous.get(targetId)?.status === 'connected'
    const isConnected = next.get(targetId)?.status === 'connected'
    if (wasConnected !== isConnected && scopedTargetIds.has(targetId)) {
      changed.push(targetId)
    }
  }
  return changed
}
