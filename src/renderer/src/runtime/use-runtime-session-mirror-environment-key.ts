import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getReachableRuntimeSessionMirrorTargets } from '@/lib/runtime-session-mirror-targets'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

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
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
  }
}

export type RuntimeSessionMirrorEnvironmentKeys = {
  // All retained-state stamps derive from this identity; transport flaps must not invalidate it (#19647).
  environmentKey: string
  // Reconnect reinstalls dead-transport subscriptions without changing environmentKey or frame stamps.
  resubscribeSignal: string
}

export function buildRuntimeSessionMirrorEnvironmentKeys(
  inputs: RuntimeSessionMirrorTargetInputs
): RuntimeSessionMirrorEnvironmentKeys {
  const targets = getReachableRuntimeSessionMirrorTargets({
    settings: { activeRuntimeEnvironmentId: inputs.activeRuntimeEnvironmentId },
    repos: inputs.repos,
    worktreesByRepo: selectWorktreesByRepo(inputs),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(inputs),
    projectGroups: inputs.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: inputs.restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments: inputs.runtimeEnvironments,
    runtimeStatusByEnvironmentId: inputs.runtimeStatusByEnvironmentId
  })
  return {
    environmentKey: targets
      .map(
        ({ environmentId, runtimeId, connectionGeneration, pairingRevision }) =>
          `${environmentId}\u0001${runtimeId}\u0001${connectionGeneration}\u0001${pairingRevision}`
      )
      .join('\u0000'),
    resubscribeSignal: targets
      .map(({ environmentId, hostContactEpoch }) => `${environmentId}\u0001${hostContactEpoch}`)
      .join('\u0000')
  }
}

export function useRuntimeSessionMirrorEnvironmentKeys(): RuntimeSessionMirrorEnvironmentKeys {
  // Agent/tab writes are hot; rescan ownership only when its sources change.
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
      buildRuntimeSessionMirrorEnvironmentKeys({
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
