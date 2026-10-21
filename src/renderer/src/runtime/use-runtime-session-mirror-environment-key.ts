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

export type RuntimeSessionMirrorEnvironmentKeys = {
  /**
   * Identity of the mirrored set. Every retained-state stamp is cut from these fields, so moving
   * this key invalidates the mirror -- which is exactly why a flap must not move it (#19647).
   */
  environmentKey: string
  /**
   * Advances when a mirrored host answers again after contact was lost. Purely an effect
   * dependency: it reinstalls the subscriptions the dead transport took with it, and is
   * deliberately absent from `environmentKey` so no frame can be stamped with it.
   */
  resubscribeSignal: string
}

export function buildRuntimeSessionMirrorEnvironmentKeys(
  inputs: RuntimeSessionMirrorTargetInputs
): RuntimeSessionMirrorEnvironmentKeys {
  const targets = getReachableRuntimeSessionMirrorTargets({
    settings: { activeRuntimeEnvironmentId: inputs.activeRuntimeEnvironmentId },
    repos: inputs.repos,
    worktreesByRepo: inputs.worktreesByRepo,
    detectedWorktreesByRepo: inputs.detectedWorktreesByRepo,
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
