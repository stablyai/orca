import type { StoreApi } from 'zustand'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { tabHasLivePty } from '../lib/tab-has-live-pty'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import { resolveDirectSshTargetScope } from '../lib/direct-ssh-target-scope'
import type { AppState } from '../store/types'
import {
  admitDirectSshSnapshotApplyToken,
  type DirectSshPreparationToken,
  type DirectSshSnapshotApplyToken
} from './direct-ssh-reconnect-coordinator'
import { directSshAuthoritiesEqual } from './direct-ssh-reconnect-tokens'
import {
  mergeDirectSshRemoteWorkspaceSession,
  uniqueWorktreeIdByPath
} from './remote-workspace-session-merge'

const REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS = 1_000
const SNAPSHOT_TERMINAL_RECONNECT_TIMEOUT_MS = 30_000
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
  waitForWorkspaceSessionReady: () => Promise<boolean>
  finalizeHydratedTerminals: (authority: DirectSshAuthority) => number
}

function exactTargetWorktreeIds(state: AppState, authority: DirectSshAuthority): Set<string> {
  return resolveDirectSshTargetScope({
    targetId: authority.targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }).gitWorktreeIds
}

function currentRecoveryTabIds(
  state: AppState,
  authority: DirectSshAuthority,
  worktreeIds: ReadonlySet<string>
): Set<string> {
  const targetTabIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    )
  )
  return new Set(
    [
      ...Object.entries(state.directSshPaneRetryByTabId),
      ...Object.entries(state.directSshLivePtyBindingByTabId)
    ]
      .filter(
        ([tabId, entry]) =>
          targetTabIds.has(tabId) && directSshAuthoritiesEqual(entry.authority, authority)
      )
      .map(([tabId]) => tabId)
  )
}

/** Tab ids that are live under the current authority but absent from the
 *  snapshot's tab lists for the in-scope worktrees. A pty running on the target
 *  host is ground truth the metadata store cannot contradict: a snapshot that
 *  does not list such a tab predates the local session write that created it
 *  (the write is still debounced, suppressed, or in flight), so applying it
 *  unmodified would delete the tab while its terminal keeps running
 *  unreachable on the host. */
export function staleDirectSshSnapshotTabIds(
  remoteTabsByWorktree: WorkspaceSessionState['tabsByWorktree'],
  worktreeIds: ReadonlySet<string>,
  liveLocalTabIds: ReadonlySet<string>
): string[] {
  if (liveLocalTabIds.size === 0) {
    return []
  }
  const remoteTabIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (remoteTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    )
  )
  return [...liveLocalTabIds].filter((tabId) => !remoteTabIds.has(tabId))
}

/** Append the named local tabs to the snapshot session's per-worktree tab
 *  lists. Only the tab lists are grafted: the merge preserves layouts and
 *  session ids from the current session for every tab in its preserve set, so
 *  grafted tabs keep their local state through the normal merge path — and
 *  remote-only tabs from other clients still apply, which a whole-apply skip
 *  would silently drop from the store on the next full-session push. */
export function graftLocalTabsIntoRemoteSession(
  remoteSession: WorkspaceSessionState,
  worktreeIds: ReadonlySet<string>,
  localTabsByWorktree: AppState['tabsByWorktree'],
  graftTabIds: ReadonlySet<string>
): WorkspaceSessionState {
  if (graftTabIds.size === 0) {
    return remoteSession
  }
  const tabsByWorktree = { ...remoteSession.tabsByWorktree }
  for (const worktreeId of worktreeIds) {
    const extras = (localTabsByWorktree[worktreeId] ?? []).filter((tab) => graftTabIds.has(tab.id))
    if (extras.length === 0) {
      continue
    }
    tabsByWorktree[worktreeId] = [...(tabsByWorktree[worktreeId] ?? []), ...extras]
  }
  return { ...remoteSession, tabsByWorktree }
}

export async function applyDirectSshRemoteWorkspaceSnapshot({
  store,
  snapshot,
  token,
  arrival,
  isArrivalCurrent,
  isPreparationTokenCurrent,
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
  // Why: recovery-ledger entries cover tabs mid-reattach; ptyIdsByTabId covers
  // tabs whose pty already attached — a freshly created tab is only in the
  // latter, and it is the tab a stale snapshot is most likely to be missing.
  const recoveryTabIds = currentRecoveryTabIds(state, authority, worktreeIds)
  const attachedTabIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (state.tabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
        .map((tab) => tab.id)
    )
  )
  const staleTabIds = staleDirectSshSnapshotTabIds(
    remoteSession.tabsByWorktree,
    worktreeIds,
    new Set([...recoveryTabIds, ...attachedTabIds])
  )
  if (staleTabIds.length > 0) {
    console.warn(
      '[remote-workspace] snapshot predates live local terminals; keeping them through the merge',
      staleTabIds
    )
  }
  const merged = mergeDirectSshRemoteWorkspaceSession(
    buildWorkspaceSessionPayload(state),
    graftLocalTabsIntoRemoteSession(
      remoteSession,
      worktreeIds,
      state.tabsByWorktree,
      new Set(staleTabIds)
    ),
    worktreeIds,
    state.tabsByWorktree,
    new Set([...recoveryTabIds, ...staleTabIds])
  )
  if (!isArrivalCurrent(authority.targetId, arrival) || !isPreparationTokenCurrent(token)) {
    return
  }
  snapshotApplyDepth += 1
  try {
    const currentStore = store.getState()
    const replaceWorkspaceKeys = [...worktreeIds]
    currentStore.hydrateWorkspaceSession(merged, {
      directSshAuthority: authority,
      replaceWorkspaceKeys
    })
    currentStore.hydrateTabsSession(merged, { replaceWorkspaceKeys })
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
            workspaceKeys: replaceWorkspaceKeys
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
    if (isArrivalCurrent(authority.targetId, arrival) && isPreparationTokenCurrent(token)) {
      finalizeHydratedTerminals(authority)
    }
  } finally {
    snapshotWriteSuppressUntil = Date.now() + REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS
    snapshotApplyDepth -= 1
  }
}
