import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { getReachableRuntimeSessionMirrorTargets } from '@/runtime/web-session-tabs-sync/subscriptions/runtime-session-mirror-targets'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { AppState } from '@/store/types'

export type RuntimeSessionMirrorTargetInputs = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'runtimeEnvironments'
> & {
  activeRuntimeEnvironmentId: string | null
  runtimeStatusByEnvironmentId: RuntimeStatuses
}

export function selectRuntimeSessionMirrorTargetInputs(
  state: AppState,
  statuses: RuntimeStatuses
): RuntimeSessionMirrorTargetInputs {
  return {
    activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId ?? null,
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: statuses
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
  const inputs = useAppStoreWithHostStatuses(selectRuntimeSessionMirrorTargetInputs, shallow)
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
