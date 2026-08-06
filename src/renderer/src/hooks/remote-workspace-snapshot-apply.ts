import type { StoreApi } from 'zustand'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import type { AppState } from '../store/types'
import {
  admitDirectSshSnapshotApplyToken,
  type DirectSshPreparationToken,
  type DirectSshSnapshotApplyToken
} from './direct-ssh-reconnect-coordinator'
import { directSshAuthoritiesEqual } from './direct-ssh-reconnect-tokens'
import {
  buildDeferredWorktreeMerge,
  classifyDepartedDeferredPaths,
  currentRecoveryTabIds,
  deferredSnapshotTabPaths,
  exactTargetWorktreeIds
} from './remote-workspace-deferred-hydration'
import {
  mergeDirectSshRemoteWorkspaceSession,
  uniqueWorktreeIdByPath
} from './remote-workspace-session-merge'

const REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS = 1_000
const SNAPSHOT_TERMINAL_RECONNECT_TIMEOUT_MS = 30_000
const SNAPSHOT_DEFERRED_RESOLVE_TIMEOUT_MS = 600_000
const SNAPSHOT_DEFERRED_POLL_MS = 1_000
let snapshotApplyDepth = 0
let snapshotWriteSuppressUntil = 0

export function isDirectSshRemoteWorkspaceApplyInProgress(): boolean {
  return snapshotApplyDepth > 0 || Date.now() < snapshotWriteSuppressUntil
}

type RemoteWorkspaceSnapshotApplyInput = {
  store: Pick<StoreApi<AppState>, 'getState'>
  snapshot: RemoteWorkspaceSnapshot
  token: DirectSshSnapshotApplyToken
  arrival: number
  isArrivalCurrent: (targetId: string, arrival: number) => boolean
  isPreparationTokenCurrent: (token: DirectSshPreparationToken) => boolean
  getCurrentAuthority: (targetId: string) => DirectSshAuthority | null
  waitForWorkspaceSessionReady: () => Promise<boolean>
  finalizeHydratedTerminals: (authority: DirectSshAuthority) => number
}

async function hydrateAndReconnectWorktrees(
  store: Pick<StoreApi<AppState>, 'getState'>,
  merged: WorkspaceSessionState,
  workspaceKeys: string[],
  authority: DirectSshAuthority,
  snapshot: RemoteWorkspaceSnapshot,
  isStillCurrent: () => boolean,
  finalizeHydratedTerminals: (authority: DirectSshAuthority) => number
): Promise<void> {
  snapshotApplyDepth += 1
  try {
    const currentStore = store.getState()
    currentStore.hydrateWorkspaceSession(merged, {
      directSshAuthority: authority,
      replaceWorkspaceKeys: workspaceKeys
    })
    currentStore.hydrateTabsSession(merged, { replaceWorkspaceKeys: workspaceKeys })
    // Why: direct SSH snapshots project terminal state only; global editor/browser hydration would reset unrelated hosts.
    currentStore.markRemoteWorkspaceHydrated(authority.targetId)
    currentStore.setRemoteWorkspaceSyncStatus(authority.targetId, {
      phase: 'synced',
      direction: 'pull',
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.4f78ba5885', 'Workspace synced')
    })
    const reconnectAbort = new AbortController()
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      Promise.resolve()
        .then(() =>
          store.getState().reconnectPersistedTerminals(reconnectAbort.signal, {
            directSshAuthority: authority,
            workspaceKeys
          })
        )
        .catch(() => {}),
      new Promise<void>((resolve) => {
        reconnectTimer = setTimeout(() => {
          reconnectAbort.abort()
          resolve()
        }, SNAPSHOT_TERMINAL_RECONNECT_TIMEOUT_MS)
      })
    ])
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
    }
    if (isStillCurrent()) {
      finalizeHydratedTerminals(authority)
    }
  } finally {
    snapshotWriteSuppressUntil = Date.now() + REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS
    snapshotApplyDepth -= 1
  }
}

export async function applyDirectSshRemoteWorkspaceSnapshot({
  store,
  snapshot,
  token,
  arrival,
  isArrivalCurrent,
  isPreparationTokenCurrent,
  getCurrentAuthority,
  waitForWorkspaceSessionReady,
  finalizeHydratedTerminals
}: RemoteWorkspaceSnapshotApplyInput): Promise<void> {
  const { authority } = token
  if (!isArrivalCurrent(authority.targetId, arrival)) {
    return
  }
  if (
    !isPreparationTokenCurrent(token) ||
    !admitDirectSshSnapshotApplyToken(token, authority, snapshot.revision)
  ) {
    return
  }
  if (!(await waitForWorkspaceSessionReady())) {
    if (isArrivalCurrent(authority.targetId, arrival) && isPreparationTokenCurrent(token)) {
      store.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'error',
        direction: 'pull',
        message: translate(
          'auto.hooks.useIpcEvents.88214a785b',
          'Workspace sync waited for local session hydration and timed out'
        )
      })
    }
    return
  }
  const state = store.getState()
  const worktreeIds = exactTargetWorktreeIds(state, authority)
  const remoteSession = importRemoteWorkspaceSession(snapshot.session, {
    resolveWorktreeId: uniqueWorktreeIdByPath(worktreeIds)
  })
  const merged = mergeDirectSshRemoteWorkspaceSession(
    buildWorkspaceSessionPayload(state),
    remoteSession,
    worktreeIds,
    state.tabsByWorktree,
    currentRecoveryTabIds(state, authority, worktreeIds)
  )
  if (!isArrivalCurrent(authority.targetId, arrival) || !isPreparationTokenCurrent(token)) {
    return
  }
  // Why: the hydrate below marks the target hydrated and then awaits terminal reconnects for up to 30s; the pending paths must be registered first or the initial-terminal gate reads "hydrated, nothing pending" and creates a junk tab into a still-empty deferred worktree.
  store
    .getState()
    .setPendingDeferredWorktreePaths(
      authority.targetId,
      deferredSnapshotTabPaths(state, authority, snapshot)
    )
  await hydrateAndReconnectWorktrees(
    store,
    merged,
    [...worktreeIds],
    authority,
    snapshot,
    () => isArrivalCurrent(authority.targetId, arrival) && isPreparationTokenCurrent(token),
    finalizeHydratedTerminals
  )

  // Why: the import above silently drops snapshot paths the catalog cannot resolve yet; remote catalogs fill in asynchronously (often only on worktree activation), so retry those paths until they resolve or the deadline expires.
  let pendingPaths = deferredSnapshotTabPaths(store.getState(), authority, snapshot)
  store.getState().setPendingDeferredWorktreePaths(authority.targetId, pendingPaths)
  if (pendingPaths.length === 0) {
    return
  }
  console.warn(
    '[remote-workspace] snapshot tabs deferred until the worktree catalog resolves their paths',
    pendingPaths
  )
  // Why: only arrival supersession or authority loss ends the watch; preparation tokens also go stale on every routine catalog refresh, which must not abort a pending late hydrate.
  const isWatchCurrent = (): boolean =>
    isArrivalCurrent(authority.targetId, arrival) &&
    directSshAuthoritiesEqual(getCurrentAuthority(authority.targetId), authority)
  const reportUnresolved = (): void => {
    store.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
      phase: 'error',
      direction: 'pull',
      message: translate(
        'auto.hooks.useIpcEvents.deferredWorktreeTabsUnresolved',
        'Some remote worktree tabs were not restored because their worktrees never appeared in the catalog'
      )
    })
  }
  const deferredDeadline = Date.now() + SNAPSHOT_DEFERRED_RESOLVE_TIMEOUT_MS
  let unresolvedSeen = false
  while (isWatchCurrent()) {
    if (Date.now() >= deferredDeadline) {
      console.warn(
        '[remote-workspace] giving up on deferred snapshot tabs; their worktree paths never resolved in the catalog',
        pendingPaths
      )
      // Why: an expired path will never hydrate — leaving it registered would suppress initial-terminal creation for that worktree indefinitely.
      store.getState().setPendingDeferredWorktreePaths(authority.targetId, [])
      reportUnresolved()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_DEFERRED_POLL_MS))
    if (!isWatchCurrent()) {
      return
    }
    const lateState = store.getState()
    const remaining = deferredSnapshotTabPaths(lateState, authority, snapshot)
    const departed = pendingPaths.filter((worktreePath) => !remaining.includes(worktreePath))
    pendingPaths = remaining
    store.getState().setPendingDeferredWorktreePaths(authority.targetId, pendingPaths)
    if (departed.length === 0) {
      continue
    }
    const { resolved, unresolvable } = classifyDepartedDeferredPaths(lateState, authority, departed)
    if (unresolvable.length > 0) {
      // Why: an ambiguous path (duplicate worktree paths in the catalog) can never resolve by polling — surface the failure instead of ending the watch on a false synced status.
      console.warn(
        '[remote-workspace] deferred snapshot tabs dropped; their worktree paths resolved ambiguously in the catalog',
        unresolvable
      )
      unresolvedSeen = true
    }
    if (resolved.length > 0) {
      const { lateScope, lateMerged } = buildDeferredWorktreeMerge(
        lateState,
        authority,
        snapshot,
        resolved
      )
      if (!isWatchCurrent()) {
        return
      }
      console.warn(
        '[remote-workspace] late catalog resolution hydrating deferred snapshot worktrees',
        resolved
      )
      await hydrateAndReconnectWorktrees(
        store,
        lateMerged,
        [...lateScope],
        authority,
        snapshot,
        isWatchCurrent,
        finalizeHydratedTerminals
      )
    }
    // Why: the hydrate above writes a synced status and status writes are last-write-wins — a tab loss must outlive every later success, including when the connection dies mid-hydrate; only a superseding arrival owns the status instead.
    if (unresolvedSeen && isArrivalCurrent(authority.targetId, arrival)) {
      reportUnresolved()
    }
    if (pendingPaths.length === 0) {
      return
    }
  }
}
