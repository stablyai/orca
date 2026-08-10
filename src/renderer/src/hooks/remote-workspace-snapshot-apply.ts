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
import type { DirectSshTabMutationReconciliation } from './remote-workspace-tab-presence-reconciliation'
import type { DirectSshTabIntentObserver } from './direct-ssh-tab-intent-observer'
import {
  graftLocalTabsIntoRemoteSession,
  omitPendingLocalTabDeletions,
  postBoundaryDeletedTabIds,
  postBoundaryLocalTabIds
} from './remote-workspace-tab-presence-reconciliation'

const REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS = 1_000
const SNAPSHOT_TERMINAL_RECONNECT_TIMEOUT_MS = 30_000
let snapshotApplyDepth = 0
let snapshotWriteSuppressUntil = 0
let snapshotIdleTimer: ReturnType<typeof setTimeout> | null = null
const snapshotIdleListeners = new Set<() => void>()

export function isDirectSshRemoteWorkspaceApplyInProgress(): boolean {
  return snapshotApplyDepth > 0 || Date.now() < snapshotWriteSuppressUntil
}

export function subscribeDirectSshRemoteWorkspaceApplyIdle(listener: () => void): () => void {
  snapshotIdleListeners.add(listener)
  return () => snapshotIdleListeners.delete(listener)
}

function scheduleSnapshotIdleNotification(): void {
  if (snapshotIdleTimer !== null) {
    clearTimeout(snapshotIdleTimer)
  }
  snapshotIdleTimer = setTimeout(
    () => {
      snapshotIdleTimer = null
      if (!isDirectSshRemoteWorkspaceApplyInProgress()) {
        for (const listener of snapshotIdleListeners) {
          listener()
        }
      }
    },
    Math.max(0, snapshotWriteSuppressUntil - Date.now())
  )
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
  preexistingLocalTabIds: ReadonlySet<string>
  tabMutations?: DirectSshTabMutationReconciliation
  tabIntentObserver?: Pick<DirectSshTabIntentObserver, 'beginSnapshotApply'>
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
  preexistingLocalTabIds,
  tabMutations,
  tabIntentObserver
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
  const importedRemoteSession = importRemoteWorkspaceSession(snapshot.session, {
    resolveWorktreeId: uniqueWorktreeIdByPath(worktreeIds)
  })
  const localTabIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    )
  )
  tabMutations?.acknowledgeSnapshot(authority.targetId, snapshot)
  if (tabMutations?.canApplySnapshot?.(authority.targetId) === false) {
    return
  }
  const pendingTabPresence = tabMutations?.pendingTabPresence(authority.targetId) ?? new Map()
  const pendingLocalTabIds = new Set(
    [...pendingTabPresence]
      .filter(([, presence]) => presence === 'present')
      .map(([tabId]) => tabId)
      .filter((tabId) => localTabIds.has(tabId))
  )
  const pendingDeletedTabIds = new Set([
    ...[...pendingTabPresence]
      .filter(([, presence]) => presence === 'absent')
      .map(([tabId]) => tabId),
    ...postBoundaryDeletedTabIds(worktreeIds, state.tabsByWorktree, preexistingLocalTabIds)
  ])
  const remoteSession = omitPendingLocalTabDeletions(importedRemoteSession, pendingDeletedTabIds)
  const recoveryTabIds = currentRecoveryTabIds(state, authority, worktreeIds)
  const postBoundaryTabIds = postBoundaryLocalTabIds(
    remoteSession.tabsByWorktree,
    worktreeIds,
    state.tabsByWorktree,
    preexistingLocalTabIds
  )
  const merged = mergeDirectSshRemoteWorkspaceSession(
    buildWorkspaceSessionPayload(state),
    graftLocalTabsIntoRemoteSession(
      remoteSession,
      worktreeIds,
      state.tabsByWorktree,
      new Set([...postBoundaryTabIds, ...pendingLocalTabIds])
    ),
    worktreeIds,
    state.tabsByWorktree,
    new Set([...recoveryTabIds, ...postBoundaryTabIds, ...pendingLocalTabIds])
  )
  if (!isArrivalCurrent(authority.targetId, arrival) || !isPreparationTokenCurrent(token)) {
    return
  }
  if (snapshotIdleTimer !== null) {
    clearTimeout(snapshotIdleTimer)
    snapshotIdleTimer = null
  }
  snapshotApplyDepth += 1
  try {
    const currentStore = store.getState()
    const replaceWorkspaceKeys = [...worktreeIds]
    const finishMutationReconciliation = tabMutations?.beginSnapshotApply(authority.targetId)
    const finishIntentObservation = tabIntentObserver?.beginSnapshotApply(authority.targetId)
    try {
      currentStore.hydrateWorkspaceSession(merged, {
        directSshAuthority: authority,
        replaceWorkspaceKeys
      })
      currentStore.hydrateTabsSession(merged, { replaceWorkspaceKeys })
    } finally {
      finishMutationReconciliation?.()
      finishIntentObservation?.()
    }
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
    scheduleSnapshotIdleNotification()
  }
}
