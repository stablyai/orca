import type { StoreApi } from 'zustand'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
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
import { selectHostRetiredTabIdsByWorktree } from './remote-workspace-host-ack-ledger'
import { retireHostClosedTabsFromSession } from './remote-workspace-host-tab-retirement'
import { sweepRetiredTerminalTabState } from '../store/slices/retired-terminal-tab-state-sweep'

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
  /** `workspace.changed`'s sourceClientId: which client wrote this listing. Absent for pulls. */
  publisherClientId?: string | null
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

export async function applyDirectSshRemoteWorkspaceSnapshot({
  store,
  snapshot,
  token,
  arrival,
  isArrivalCurrent,
  isPreparationTokenCurrent,
  waitForWorkspaceSessionReady,
  finalizeHydratedTerminals,
  publisherClientId
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
  // Why the ids are selected BEFORE the merge: the merge is what preserves a host-unknown tab, so
  // afterwards absence and preservation are indistinguishable again. Read against pre-merge local
  // state, an id here means the client publishing this snapshot once listed the tab and now does not.
  //
  // What makes that safe is the retraction rule alone (see selectHostRetiredTabIdsByWorktree): only a
  // publisher that itself listed the id, under a path it still describes, can drop it. No local-pty
  // predicate is consulted, deliberately — this apply ends by running finalizeHydratedTerminals,
  // which is retryDirectSshTargetPanes (useIpcEvents.ts:731-733), so by the time the next snapshot
  // arrives every tab of the target has a retry entry and a bumped generation (and a live binding
  // once its pane settles). Any veto built on those is satisfied by every tab and silently disables
  // retirement.
  const retiredTabIdsByWorktreeId = selectHostRetiredTabIdsByWorktree({
    ledger: state.remoteWorkspaceHostAckByTargetId,
    targetId: authority.targetId,
    snapshot,
    publisherId: publisherClientId,
    localTabsByWorktree: state.tabsByWorktree,
    worktreeIds
  })
  // Why collected: a peer's close owes the tab the same renderer-side sweep a local closeTab runs.
  // Only ids the primitive really removed land here, so a pinned tab keeps its agent status.
  const retiredWorktreeIdByTabId = new Map<string, string>()
  const merged = retireHostClosedTabsFromSession(
    mergeDirectSshRemoteWorkspaceSession(
      buildWorkspaceSessionPayload(state),
      remoteSession,
      worktreeIds,
      state.tabsByWorktree,
      currentRecoveryTabIds(state, authority, worktreeIds)
    ),
    retiredTabIdsByWorktreeId,
    { onTabRetired: (tabId, worktreeId) => retiredWorktreeIdByTabId.set(tabId, worktreeId) }
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
    // Why here: the retired tabs are out of tabsByWorktree now (the completed-orphan sweep is defined
    // against that), and snapshotApplyDepth still suppresses the store writes from re-publishing.
    for (const [tabId, worktreeId] of retiredWorktreeIdByTabId) {
      sweepRetiredTerminalTabState(currentStore, tabId, worktreeId)
    }
    // Why after hydrate: this listing is now what its publisher is known to hold, so a LATER listing
    // from the SAME publisher is what its omissions are judged against.
    currentStore.recordRemoteWorkspaceHostAck(authority.targetId, snapshot, publisherClientId)
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
