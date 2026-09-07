import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getReachableRuntimeSessionMirrorTargets } from '@/lib/runtime-session-mirror-targets'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

export type RuntimeSessionMirrorTargetInputs = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
> & {
  activeRuntimeEnvironmentId: string | null
}

export function selectRuntimeSessionMirrorTargetInputs(
  state: AppState
): RuntimeSessionMirrorTargetInputs {
  return {
    activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId ?? null,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
  }
}

export function buildRuntimeSessionMirrorEnvironmentKey(
  inputs: RuntimeSessionMirrorTargetInputs
): string {
  return getReachableRuntimeSessionMirrorTargets({
    settings: { activeRuntimeEnvironmentId: inputs.activeRuntimeEnvironmentId },
    repos: inputs.repos,
    worktreesByRepo: inputs.worktreesByRepo,
    detectedWorktreesByRepo: inputs.detectedWorktreesByRepo,
    projectGroups: inputs.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: inputs.restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments: inputs.runtimeEnvironments,
    runtimeStatusByEnvironmentId: inputs.runtimeStatusByEnvironmentId
  })
    .map(
      ({ environmentId, runtimeId, connectionGeneration, pairingRevision }) =>
        `${environmentId}\u0001${runtimeId}\u0001${connectionGeneration}\u0001${pairingRevision}`
    )
    .join('\u0000')
}

export function useRuntimeSessionMirrorEnvironmentKey(): string {
  // Why: agent/tab writes are hot; scan host ownership only when one of its sources changes.
  const inputs = useAppStore(useShallow(selectRuntimeSessionMirrorTargetInputs))
  const {
    activeRuntimeEnvironmentId,
    repos,
    worktreesByRepo,
    detectedWorktreesByRepo,
    projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId
  } = inputs
  return useMemo(
    () =>
      buildRuntimeSessionMirrorEnvironmentKey({
        activeRuntimeEnvironmentId,
        repos,
        worktreesByRepo,
        detectedWorktreesByRepo,
        projectGroups,
        restoredRuntimeHostIdByWorkspaceSessionKey,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId
      }),
    [
      activeRuntimeEnvironmentId,
      repos,
      worktreesByRepo,
      detectedWorktreesByRepo,
      projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId
    ]
  )
}
