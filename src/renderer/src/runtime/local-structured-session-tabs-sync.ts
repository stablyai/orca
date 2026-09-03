import { useEffect } from 'react'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '../store'
import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner'
import { getExecutionHostIdForWorktree } from '../lib/worktree-runtime-owner'
import { applyWebSessionTabsSnapshot, applyWebSessionTabsStorePatch } from './web-session-tabs-sync'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  noteRetiredValue,
  sameSessionTabsPublicationLineage
} from './web-session-tabs-sync/publisher-identity-fences'
import type { SessionTabsPublicationEpochHistory } from './web-session-tabs-sync/state'
import { refreshLocalRuntimeCapabilities } from './local-runtime-capabilities'

export const LOCAL_STRUCTURED_SESSION_OWNER = 'local-structured-session'
let localStructuredSessionTabsRestorePromise: Promise<void> | null = null
const localStructuredSessionVersionByWorktree = new Map<
  string,
  { publicationEpoch: string; snapshotVersion: number }
>()
const localStructuredSessionEpochHistoryByWorktree = new Map<
  string,
  SessionTabsPublicationEpochHistory
>()

export function resetLocalStructuredSessionVersionForTests(): void {
  localStructuredSessionVersionByWorktree.clear()
  localStructuredSessionEpochHistoryByWorktree.clear()
}

type SessionTabsEvent =
  | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
  | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[] }
  | { type: 'end' }

export function projectLocalStructuredSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  const structuredIds = new Set(
    snapshot.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.id)
  )
  const visibleHostTabIds = structuredIds
  const visibleIds = structuredIds
  const projectedTabGroups = snapshot.tabGroups
    ?.map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter((id) => visibleHostTabIds.has(id)),
      activeTabId:
        group.activeTabId && visibleHostTabIds.has(group.activeTabId) ? group.activeTabId : null,
      recentTabIds: group.recentTabIds?.filter((id) => visibleHostTabIds.has(id))
    }))
    .filter((group) => group.tabOrder.length > 0)

  return {
    ...snapshot,
    activeTabId: visibleIds.has(snapshot.activeTabId ?? '') ? snapshot.activeTabId : null,
    activeTabType:
      snapshot.activeTabId && visibleIds.has(snapshot.activeTabId) ? snapshot.activeTabType : null,
    activeGroupId:
      snapshot.activeGroupId &&
      projectedTabGroups?.some((group) => group.id === snapshot.activeGroupId)
        ? snapshot.activeGroupId
        : (projectedTabGroups?.[0]?.id ?? null),
    tabs: snapshot.tabs.filter((tab) => visibleIds.has(tab.id)),
    tabGroups: projectedTabGroups,
    // Why: group membership locates chats; the renderer's split tree remains locally authoritative.
    tabGroupLayout: undefined
  }
}

export function applyStructuredSessionTabSnapshots(
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  owner = LOCAL_STRUCTURED_SESSION_OWNER
): void {
  const settleStructuredSessionMirror = applyWebSessionTabsStorePatch(
    (state) => applyLocalStructuredSessionTabSnapshots(state, snapshots, owner),
    { frames: [] }
  )
  settleStructuredSessionMirror()
}

export function applyLocalStructuredSessionTabSnapshots<
  State extends WebSessionTabsSyncState & WorktreeRuntimeOwnerState
>(
  state: State,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  owner = LOCAL_STRUCTURED_SESSION_OWNER,
  now = Date.now()
): State {
  let next = state
  for (const snapshot of snapshots) {
    // Why: the execution host owns its tabs; local inventory must not rewrite paired or SSH panes.
    if (getExecutionHostIdForWorktree(next, snapshot.worktree) !== 'local') {
      continue
    }
    const prior = localStructuredSessionVersionByWorktree.get(snapshot.worktree)
    const sharesLineage = Boolean(
      prior && sameSessionTabsPublicationLineage(prior.publicationEpoch, snapshot.publicationEpoch)
    )
    const epochHistory = localStructuredSessionEpochHistoryByWorktree.get(snapshot.worktree)
    if (epochHistory?.retired.includes(snapshot.publicationEpoch) && !sharesLineage) {
      continue
    }
    if (prior && sharesLineage && snapshot.snapshotVersion <= prior.snapshotVersion) {
      continue
    }
    const patch = applyWebSessionTabsSnapshot(
      next,
      projectLocalStructuredSessionTabs(snapshot),
      owner,
      now,
      {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      }
    )
    next = patch === next ? next : ({ ...next, ...patch } as State)
    localStructuredSessionVersionByWorktree.set(snapshot.worktree, {
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion
    })
    localStructuredSessionEpochHistoryByWorktree.set(
      snapshot.worktree,
      noteRetiredValue(epochHistory, snapshot.publicationEpoch, 8)
    )
  }
  // Drop publisher cursors for worktrees that no longer exist. Without this,
  // every deleted worktree leaves an entry for the lifetime of the renderer.
  const knownWorktreeIds = new Set<string>(Object.keys(next.unifiedTabsByWorktree))
  for (const worktrees of Object.values(next.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      knownWorktreeIds.add(worktree.id)
    }
  }
  for (const detected of Object.values(next.detectedWorktreesByRepo ?? {})) {
    for (const worktree of detected.worktrees) {
      knownWorktreeIds.add(worktree.id)
    }
  }
  for (const workspace of next.folderWorkspaces ?? []) {
    knownWorktreeIds.add(folderWorkspaceKey(workspace.id))
  }
  for (const worktreeId of localStructuredSessionVersionByWorktree.keys()) {
    if (!knownWorktreeIds.has(worktreeId)) {
      localStructuredSessionVersionByWorktree.delete(worktreeId)
      localStructuredSessionEpochHistoryByWorktree.delete(worktreeId)
    }
  }
  return next
}

export function restoreLocalStructuredSessionTabsOnce(): Promise<void> {
  localStructuredSessionTabsRestorePromise ??= refreshLocalRuntimeCapabilities()
    .then(() => refreshLocalStructuredSessionTabs())
    .then(() => undefined)
    .catch((error) => {
      localStructuredSessionTabsRestorePromise = null
      throw error
    })
  return localStructuredSessionTabsRestorePromise
}

/** Fetch the current host inventory even after the startup restore has settled. */
export function refreshLocalStructuredSessionTabs(): Promise<RuntimeMobileSessionTabsResult[]> {
  return window.api.runtime
    .call({ method: 'session.tabs.listAll', params: {} })
    .then((response) => {
      if (!response.ok) {
        throw new Error('structured session inventory unavailable')
      }
      const result = response.result as { snapshots?: RuntimeMobileSessionTabsResult[] }
      const snapshots = result.snapshots ?? []
      applyStructuredSessionTabSnapshots(snapshots)
      return snapshots
    })
}

export async function startLocalStructuredSessionTabsSync(args: {
  isDisposed: () => boolean
  setUnsubscribe: (unsubscribe: () => void) => void
}): Promise<void> {
  const capabilities = await refreshLocalRuntimeCapabilities()
  if (args.isDisposed()) {
    return
  }
  const supported = capabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
  await restoreLocalStructuredSessionTabsOnce()
  if (args.isDisposed()) {
    return
  }
  if (!supported) {
    return
  }
  let subscriptionGeneration = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let activeHandle: { unsubscribe: () => void } | null = null
  const scheduleSubscribeRetry = (): void => {
    if (args.isDisposed() || reconnectTimer !== null) {
      return
    }
    const reconnectDelay = Math.min(250 * 2 ** reconnectAttempt, 5000)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void refreshLocalStructuredSessionTabs()
        .catch((error) => console.warn('[structured-session-tabs] resync failed', error))
        .finally(() => {
          if (!args.isDisposed()) {
            void subscribeCurrent().catch((error) => {
              console.warn('[structured-session-tabs] resubscribe failed', error)
              scheduleSubscribeRetry()
            })
          }
        })
    }, reconnectDelay)
  }
  const subscribeCurrent = async (): Promise<void> => {
    if (args.isDisposed()) {
      return
    }
    const generation = ++subscriptionGeneration
    let handle: { unsubscribe: () => void } | null = null
    handle = await window.api.runtime.subscribe(
      { method: 'session.tabs.subscribeAll', params: {} },
      (response) => {
        if (args.isDisposed() || generation !== subscriptionGeneration) {
          return
        }
        if (!response.ok) {
          // A streaming RPC can terminate with an error response before its
          // handle resolves; fence that generation and retry the subscription.
          subscriptionGeneration += 1
          handle?.unsubscribe()
          if (activeHandle === handle) {
            activeHandle = null
          }
          scheduleSubscribeRetry()
          return
        }
        const event = response.result as SessionTabsEvent
        if (event.type === 'snapshots') {
          applyStructuredSessionTabSnapshots(event.snapshots)
        } else if (event.type === 'snapshot' || event.type === 'updated') {
          applyStructuredSessionTabSnapshots([event])
        } else if (event.type === 'end' && generation === subscriptionGeneration) {
          // Reattach with one refresh so a runtime-restart boundary cannot strand stale tabs.
          subscriptionGeneration += 1
          handle?.unsubscribe()
          if (activeHandle === handle) {
            activeHandle = null
          }
          if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer)
          }
          scheduleSubscribeRetry()
        }
      }
    )
    if (args.isDisposed() || generation !== subscriptionGeneration) {
      handle.unsubscribe()
    } else {
      activeHandle = handle
    }
  }
  args.setUnsubscribe(() => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    activeHandle?.unsubscribe()
    activeHandle = null
  })
  void subscribeCurrent().catch((error) => {
    console.warn('[structured-session-tabs] subscribe failed', error)
    scheduleSubscribeRetry()
  })
}

export function useLocalStructuredSessionTabsSync(): void {
  const ready = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  useEffect(() => {
    if (!ready) {
      return
    }
    let disposed = false
    let unsubscribe = (): void => {}
    void startLocalStructuredSessionTabsSync({
      isDisposed: () => disposed,
      setUnsubscribe: (next) => {
        unsubscribe = next
      }
    }).catch((error) => console.warn('[structured-session-tabs] sync failed', error))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [ready])
}
