import type { RemoteWorkspaceObservedSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import type {
  DirectSshPreparationToken,
  DirectSshSnapshotApplyToken
} from './direct-ssh-reconnect-coordinator'
import { buildDirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator'
import { resolveExactDirectSshTargetWorktreeIds } from './remote-workspace-snapshot-placement'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import { createRemoteWorkspaceSnapshotArrivalCoordinator } from './remote-workspace-snapshot-arrival-coordinator'
import { createDeferredSnapshotPlacementRetries } from './remote-workspace-deferred-placement-retry'
import { applyRemoteWorkspacePushStatus } from './remote-workspace-push-status'
import { waitForRemoteWorkspaceSessionReady } from './remote-workspace-session-readiness'
import type {
  RemoteWorkspaceTargetSync,
  RemoteWorkspaceTargetSyncDeps
} from './remote-workspace-target-sync-types'

export type {
  RemoteWorkspaceTargetSync,
  RemoteWorkspaceTargetSyncDeps
} from './remote-workspace-target-sync-types'

const MAX_SNAPSHOT_APPLY_ATTEMPTS = 3

export function createRemoteWorkspaceTargetSync(
  deps: RemoteWorkspaceTargetSyncDeps
): RemoteWorkspaceTargetSync {
  const arrivals = createRemoteWorkspaceSnapshotArrivalCoordinator()
  const deferredPlacementRetries = createDeferredSnapshotPlacementRetries({
    store: deps.store,
    getCurrentAuthority: deps.getCurrentAuthority,
    getSnapshot: (targetId) => deps.remoteWorkspace.get({ targetId }),
    applySnapshot: (targetId, snapshot) => applyUnsolicitedSnapshot(targetId, snapshot)
  })

  const isArrivalCurrent = arrivals.isCurrent

  const markSnapshotConflict = (
    authority: DirectSshAuthority,
    snapshot: RemoteWorkspaceObservedSnapshot,
    arrival: number
  ): void => {
    if (!isArrivalCurrent(authority.targetId, arrival)) {
      return
    }
    const state = deps.store.getState()
    state.clearRemoteWorkspaceHydrated(authority.targetId)
    state.setRemoteWorkspaceSyncStatus(authority.targetId, {
      phase: 'conflict',
      direction: 'pull',
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      hostObservationToken: snapshot.hostObservationToken
    })
  }

  const applySnapshotWithCurrentPreparation = async (
    authority: DirectSshAuthority,
    snapshot: RemoteWorkspaceObservedSnapshot,
    arrival: number,
    arrivalSignal: AbortSignal,
    initialToken: DirectSshSnapshotApplyToken
  ): Promise<void> => {
    let applyToken = initialToken
    for (let attempt = 0; attempt < MAX_SNAPSHOT_APPLY_ATTEMPTS; attempt += 1) {
      let unplacedTabWorktreePaths: readonly string[] = []
      const result = await applyDirectSshRemoteWorkspaceSnapshot({
        store: deps.store,
        snapshot,
        token: applyToken,
        arrival,
        arrivalSignal,
        isArrivalCurrent,
        isPreparationTokenCurrent: deps.isPreparationTokenCurrent,
        waitForWorkspaceSessionReady: (signal) =>
          waitForRemoteWorkspaceSessionReady(deps.store, signal),
        finalizeHydratedTerminals: deps.finalizeHydratedTerminals,
        onUnplacedTabWorktreePaths: (worktreePaths) => {
          unplacedTabWorktreePaths = worktreePaths
        }
      })
      if (result === 'applied') {
        deferredPlacementRetries.watch(authority, unplacedTabWorktreePaths)
      }
      if (result !== 'stale' || !isArrivalCurrent(authority.targetId, arrival)) {
        return
      }
      if (attempt === MAX_SNAPSHOT_APPLY_ATTEMPTS - 1) {
        break
      }
      const input = await deps.capturePreparationInput(
        authority,
        'workspace-snapshot',
        snapshot.revision
      )
      if (!input || !isArrivalCurrent(authority.targetId, arrival)) {
        markSnapshotConflict(authority, snapshot, arrival)
        return
      }
      const prepared = await deps.prepareOnly(input)
      if (
        !prepared.token ||
        !deps.isPreparationTokenCurrent(prepared.token) ||
        !isArrivalCurrent(authority.targetId, arrival)
      ) {
        markSnapshotConflict(authority, snapshot, arrival)
        return
      }
      const refreshedToken = buildDirectSshSnapshotApplyToken(prepared.token, snapshot.revision)
      if (!refreshedToken) {
        markSnapshotConflict(authority, snapshot, arrival)
        return
      }
      applyToken = refreshedToken
    }
    markSnapshotConflict(authority, snapshot, arrival)
  }

  const syncAfterConnectArrival = async (
    token: DirectSshPreparationToken,
    arrival: number,
    arrivalSignal: AbortSignal
  ): Promise<void> => {
    const { authority } = token
    const workspaceReady = await waitForRemoteWorkspaceSessionReady(deps.store, arrivalSignal)
    if (!isArrivalCurrent(authority.targetId, arrival) || !deps.isPreparationTokenCurrent(token)) {
      return
    }
    if (!workspaceReady) {
      deps.store.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'error',
        direction: 'pull',
        message: translate(
          'auto.hooks.useIpcEvents.88214a785b',
          'Workspace sync waited for local session hydration and timed out'
        )
      })
      return
    }
    const stateBeforeGet = deps.store.getState()
    const worktreeIds = resolveExactDirectSshTargetWorktreeIds(stateBeforeGet, authority)
    const hasLocalTabs = [...worktreeIds].some(
      (worktreeId) => (stateBeforeGet.tabsByWorktree[worktreeId] ?? []).length > 0
    )
    stateBeforeGet.setRemoteWorkspaceSyncStatus(authority.targetId, {
      phase: 'pulling',
      direction: 'pull'
    })
    const snapshot = await deps.remoteWorkspace.get({ targetId: authority.targetId })
    if (!isArrivalCurrent(authority.targetId, arrival) || !deps.isPreparationTokenCurrent(token)) {
      return
    }
    if (!snapshot) {
      deps.store.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'offline',
        direction: 'pull',
        message: translate(
          'auto.hooks.useIpcEvents.2fe88c2e06',
          'Remote workspace sync unavailable'
        )
      })
      return
    }
    if (snapshot.revision > 0) {
      const applyToken = buildDirectSshSnapshotApplyToken(token, snapshot.revision)
      if (applyToken) {
        await applySnapshotWithCurrentPreparation(
          authority,
          snapshot,
          arrival,
          arrivalSignal,
          applyToken
        )
      }
      return
    }
    deps.store.getState().markRemoteWorkspaceHydrated(authority.targetId)
    if (!hasLocalTabs) {
      deps.store.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'idle',
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        hostObservationToken: snapshot.hostObservationToken,
        message: translate('auto.hooks.useIpcEvents.2ec42e1c52', 'No remote workspace yet')
      })
      return
    }
    if (!isArrivalCurrent(authority.targetId, arrival) || !deps.isPreparationTokenCurrent(token)) {
      return
    }
    const results = await deps.remoteWorkspace.setForConnectedTargets({
      session: buildWorkspaceSessionPayload(deps.store.getState()),
      hydratedTargetIds: [authority.targetId],
      expectedRevisionsByTargetId: { [authority.targetId]: snapshot.revision },
      expectedHostObservationTokensByTargetId: {
        [authority.targetId]: snapshot.hostObservationToken
      }
    })
    if (!isArrivalCurrent(authority.targetId, arrival) || !deps.isPreparationTokenCurrent(token)) {
      return
    }
    const result = results.find((entry) => entry.targetId === authority.targetId)?.result
    applyRemoteWorkspacePushStatus(deps.store.getState(), authority.targetId, result, snapshot)
  }

  const syncAfterConnect = (token: DirectSshPreparationToken): Promise<void> =>
    arrivals.run(token.authority.targetId, (arrival, signal) =>
      syncAfterConnectArrival(token, arrival, signal)
    )

  const applyUnsolicitedSnapshotArrival = async (
    targetId: string,
    snapshot: RemoteWorkspaceObservedSnapshot,
    arrival: number,
    arrivalSignal: AbortSignal
  ): Promise<void> => {
    const authority = deps.getCurrentAuthority(targetId)
    if (!authority) {
      return
    }
    const state = deps.store.getState()
    state.clearRemoteWorkspaceHydrated(authority.targetId)
    state.setRemoteWorkspaceSyncStatus(authority.targetId, {
      phase: 'pulling',
      direction: 'pull',
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      hostObservationToken: snapshot.hostObservationToken
    })
    const input = await deps.capturePreparationInput(
      authority,
      'workspace-snapshot',
      snapshot.revision
    )
    if (!input) {
      markSnapshotConflict(authority, snapshot, arrival)
      return
    }
    if (!isArrivalCurrent(targetId, arrival)) {
      return
    }
    const prepared = await deps.prepareOnly(input)
    if (!prepared.token) {
      markSnapshotConflict(authority, snapshot, arrival)
      return
    }
    if (!isArrivalCurrent(targetId, arrival)) {
      return
    }
    const applyToken = buildDirectSshSnapshotApplyToken(prepared.token, snapshot.revision)
    if (!applyToken) {
      markSnapshotConflict(authority, snapshot, arrival)
      return
    }
    await applySnapshotWithCurrentPreparation(
      authority,
      snapshot,
      arrival,
      arrivalSignal,
      applyToken
    )
  }

  const applyUnsolicitedSnapshot = (
    targetId: string,
    snapshot: RemoteWorkspaceObservedSnapshot
  ): Promise<void> =>
    arrivals.run(targetId, (arrival, signal) =>
      applyUnsolicitedSnapshotArrival(targetId, snapshot, arrival, signal)
    )

  return {
    syncAfterConnect,
    applyUnsolicitedSnapshot,
    stop: () => {
      deferredPlacementRetries.stop()
      arrivals.stop()
    }
  }
}
