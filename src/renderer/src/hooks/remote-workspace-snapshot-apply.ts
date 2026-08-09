import type { StoreApi } from 'zustand'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
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
import { repairUnifiedTabMembershipFromLegacyTabs } from '../lib/unified-tab-membership-repair'

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
  const recoveryTabIds = new Set(
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
  for (const worktreeId of worktreeIds) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      if (tab.ptyId && parseAppSshPtyId(tab.ptyId)?.connectionId === authority.targetId) {
        recoveryTabIds.add(tab.id)
      }
    }
  }
  for (const [tabId, ptyId] of Object.entries(state.pendingReconnectPtyIdByTabId ?? {})) {
    if (targetTabIds.has(tabId) && parseAppSshPtyId(ptyId)?.connectionId === authority.targetId) {
      recoveryTabIds.add(tabId)
    }
  }
  return recoveryTabIds
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
  // Why: remote snapshots carry terminal membership in legacy format only; the
  // unified maps that drive visible tabs must be re-materialized or a restored
  // tab reattaches its PTY without ever rendering. PTY binding is required —
  // materializing unbound stale tabs spawns fresh shells and can trigger
  // sleeping-agent resume in panes the user already discarded.
  const merged = repairUnifiedTabMembershipFromLegacyTabs(
    mergeDirectSshRemoteWorkspaceSession(
      buildWorkspaceSessionPayload(state),
      remoteSession,
      worktreeIds,
      state.tabsByWorktree,
      currentRecoveryTabIds(state, authority, worktreeIds)
    ),
    { worktreeIds }
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
      store.getState().markRemoteWorkspaceHydrated(authority.targetId)
    }
  } finally {
    snapshotWriteSuppressUntil = Date.now() + REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS
    snapshotApplyDepth -= 1
  }
}
