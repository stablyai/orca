import type { StoreApi } from 'zustand'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
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

const REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS = 1_000
const SNAPSHOT_TERMINAL_RECONNECT_TIMEOUT_MS = 30_000
let snapshotApplyDepth = 0
let snapshotWriteSuppressUntil = 0

export function isDirectSshRemoteWorkspaceApplyInProgress(): boolean {
  return snapshotApplyDepth > 0 || Date.now() < snapshotWriteSuppressUntil
}

const applyWindowCloseListeners = new Set<() => void>()

/**
 * Fires once after the write-suppression tail expires. Why: the tail ends on a wall clock with no
 * store update behind it, so a session write deferred during an apply has nothing else to wake it.
 */
export function onDirectSshRemoteWorkspaceApplyWindowClosed(listener: () => void): () => void {
  applyWindowCloseListeners.add(listener)
  return () => {
    applyWindowCloseListeners.delete(listener)
  }
}

/**
 * One timer in flight per apply. It never polls: the tail deadline only moves forward, and each
 * re-arm waits exactly the time still left on it, so the wait converges instead of spinning.
 */
function scheduleApplyWindowClosedNotice(): void {
  // +1ms because the gate compares `Date.now() < suppressUntil`; fire strictly past the deadline.
  const delayMs = Math.max(0, snapshotWriteSuppressUntil - Date.now()) + 1
  setTimeout(() => {
    // An apply still in flight schedules the next notice from its own `finally`.
    if (snapshotApplyDepth > 0) {
      return
    }
    // Why re-arm rather than return: `delayMs` is wall-clock arithmetic handed to a monotonic
    // timer, so a clock step back (NTP) can leave the deadline in the future when this fires.
    // Dropping the notice there would strand every write deferred in this window.
    if (Date.now() < snapshotWriteSuppressUntil) {
      scheduleApplyWindowClosedNotice()
      return
    }
    // Safe to iterate live: Set iteration tolerates a listener unsubscribing itself.
    for (const listener of applyWindowCloseListeners) {
      listener()
    }
  }, delayMs)
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
  const unplacedTabWorktreePaths: string[] = []
  const remoteSession = importRemoteWorkspaceSession(snapshot.session, {
    resolveWorktreeId: uniqueWorktreeIdByPath(worktreeIds),
    executionHostId: toSshExecutionHostId(authority.targetId),
    onUnplacedTerminalTabs: (worktreePath) => unplacedTabWorktreePaths.push(worktreePath)
  })
  const merged = mergeDirectSshRemoteWorkspaceSession(
    buildWorkspaceSessionPayload(state),
    remoteSession,
    worktreeIds,
    state.tabsByWorktree,
    currentRecoveryTabIds(state, authority, worktreeIds),
    toSshExecutionHostId(authority.targetId),
    snapshot.revision
  )
  if (!isArrivalCurrent(authority.targetId, arrival) || !isPreparationTokenCurrent(token)) {
    return
  }
  const hasUnplacedTerminalTabs = unplacedTabWorktreePaths.length > 0
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
    if (!hasUnplacedTerminalTabs) {
      currentStore.markRemoteWorkspaceHydrated(authority.targetId)
      currentStore.setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'synced',
        direction: 'pull',
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        message: translate('auto.hooks.useIpcEvents.4f78ba5885', 'Workspace synced'),
        lastSyncedAt: Date.now()
      })
    } else {
      // The host listed tabs on paths this client cannot place, so adopting zero of them is not
      // the host's picture. `conflict` is the phase that says exactly that, and it is load-bearing
      // twice over:
      //   - use-app-session-persistence.ts filters conflicted targets out of uploads, and an
      //     upload is a `replace-session` patch (remote-workspace-relay-sync.ts) that wholesale
      //     replaces the host snapshot - it would delete the very tabs we failed to adopt;
      //   - workspace-terminal-host-authority.ts treats `offline`/`error` on an un-hydrated target
      //     as `none`, its bounded floor, which authorises seeding AND sleeping-agent resume.
      //     `conflict` is deliberately not in that set, so authority stays `unverifiable`.
      // Hydration is cleared, not merely withheld: the set is add-only, so a target that synced
      // cleanly before would otherwise keep uploading from this incomplete picture (STA-3593).
      currentStore.clearRemoteWorkspaceHydrated(authority.targetId)
      currentStore.setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'conflict',
        direction: 'pull',
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt
      })
    }
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
    scheduleApplyWindowClosedNotice()
  }
}
