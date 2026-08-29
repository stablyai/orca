// Why: a remote tab create/activate is the ONE case where the session snapshot's
// activeTabId reflects genuine user focus intent. Status-echo snapshots (e.g. an
// agent "thinking" during a run) also set activeTabId but must NOT steal focus
// (#5435). The snapshot can't distinguish these, so the client records its own
// activation intent here: the reconcile only follows the snapshot's active tab
// when it matches a pending intent the client itself initiated.
//
// Keyed by worktree id → the host session surface the client expects to focus.
// The intent persists until a snapshot matches it (surviving racing/duplicate
// snapshots, unlike a transient per-snapshot flag).

import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'
import { toVisibleTabType } from '../../../shared/tab-types'
import type { AppState } from '../store/types'

export type WebSessionFocusIntent = {
  hostTabId: string
  leafId?: string
  expectedCurrentLocalTabId?: string | null
}

const pendingFocusByOwnerAndWorktree = new Map<string, WebSessionFocusIntent>()

type WebSessionVisibleTabState = Pick<
  AppState,
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorktreeId'
  | 'groupsByWorktree'
  | 'unifiedTabsByWorktree'
>

export function resolveWebSessionVisibleTabId(
  state: WebSessionVisibleTabState,
  worktreeId: string,
  tabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
): string | null {
  // Why: the coarse (activeTabType, entityId) address inverts a many-to-one projection and cannot
  // tell editor-family kinds apart; group state is what is actually on screen.
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  if (groups.length > 0) {
    const activeGroupId = state.activeGroupIdByWorktree?.[worktreeId] ?? null
    const activeGroup =
      (activeGroupId ? groups.find((group) => group.id === activeGroupId) : null) ?? groups[0]
    // Why: authoritative that nothing is visible too — never resolve into an unfocused group.
    if (activeGroup?.activeTabId == null) {
      return null
    }
    const activeTabId = activeGroup.activeTabId
    const direct = tabs.find((tab) => tab.id === activeTabId && tab.groupId === activeGroup.id)
    if (direct) {
      return direct.id
    }
    // Why: reconcile can rematerialize the visible tab under a new id (local -> mirrored), so
    // follow its entity rather than dropping focus. Stays inside the group to avoid a pane jump.
    const previous = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (tab) => tab.id === activeTabId
    )
    if (!previous) {
      return null
    }
    const previousType = toVisibleTabType(previous.contentType)
    return (
      tabs.find(
        (tab) =>
          tab.groupId === activeGroup.id &&
          tab.entityId === previous.entityId &&
          toVisibleTabType(tab.contentType) === previousType
      )?.id ?? null
    )
  }

  // Why: no group records at all (fresh slice, or first remote reconcile before groups exist).
  const currentType =
    state.activeTabTypeByWorktree?.[worktreeId] ??
    (state.activeWorktreeId === worktreeId ? state.activeTabType : null)
  if (currentType === 'terminal') {
    const tabId = state.activeTabIdByWorktree?.[worktreeId]
    return tabId && tabs.some((tab) => tab.id === tabId) ? tabId : null
  }
  // Why: a structured chat tab has no per-worktree active-entity map to address it by, so the
  // entityId lookup below would always miss. There is at most one per worktree here.
  if (currentType === 'agent-session') {
    return tabs.find((tab) => tab.contentType === 'agent-session')?.id ?? null
  }
  const entityId =
    currentType === 'browser'
      ? state.activeBrowserTabIdByWorktree?.[worktreeId]
      : currentType === 'editor'
        ? state.activeFileIdByWorktree?.[worktreeId]
        : null
  return (
    tabs.find(
      (tab) => toVisibleTabType(tab.contentType) === currentType && tab.entityId === entityId
    )?.id ?? null
  )
}

export function resolveWebSessionSiblingVisibleTabId(
  state: WebSessionVisibleTabState,
  worktreeId: string,
  tabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
): string | null {
  const activeGroupId = state.activeGroupIdByWorktree?.[worktreeId] ?? null
  const preferredType =
    state.activeTabTypeByWorktree?.[worktreeId] ??
    (state.activeWorktreeId === worktreeId ? state.activeTabType : null)
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  let fallback: string | null = null
  for (const group of state.groupsByWorktree?.[worktreeId] ?? []) {
    if (group.id === activeGroupId || group.activeTabId == null) {
      continue
    }
    const tab = tabById.get(group.activeTabId)
    if (!tab || tab.groupId !== group.id) {
      continue
    }
    if (preferredType && toVisibleTabType(tab.contentType) === preferredType) {
      return tab.id
    }
    fallback ??= tab.id
  }
  return fallback
}

function focusIntentPartitionKey(owner: WebSessionIntentOwner, worktreeId: string): string {
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}`
}

export function recordWebSessionFocusIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  leafId?: string,
  expectedCurrentLocalTabId?: string | null
): void {
  const trimmed = hostTabId.trim()
  if (!worktreeId || !trimmed) {
    return
  }
  const trimmedLeafId = leafId?.trim()
  pendingFocusByOwnerAndWorktree.set(focusIntentPartitionKey(owner, worktreeId), {
    hostTabId: trimmed,
    ...(trimmedLeafId ? { leafId: trimmedLeafId } : {}),
    ...(expectedCurrentLocalTabId !== undefined ? { expectedCurrentLocalTabId } : {})
  })
}

export function peekWebSessionFocusIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string
): WebSessionFocusIntent | null {
  return pendingFocusByOwnerAndWorktree.get(focusIntentPartitionKey(owner, worktreeId)) ?? null
}

export function clearWebSessionFocusIntent(owner: WebSessionIntentOwner, worktreeId: string): void {
  pendingFocusByOwnerAndWorktree.delete(focusIntentPartitionKey(owner, worktreeId))
}

export function clearWebSessionFocusIntentIfMatches(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string
): void {
  const key = focusIntentPartitionKey(owner, worktreeId)
  if (pendingFocusByOwnerAndWorktree.get(key)?.hostTabId === hostTabId) {
    pendingFocusByOwnerAndWorktree.delete(key)
  }
}

export function clearWebSessionFocusIntentsForOwner(owner: WebSessionIntentOwner): void {
  const prefix = `${webSessionIntentOwnerKey(owner)}\0`
  for (const key of pendingFocusByOwnerAndWorktree.keys()) {
    if (key.startsWith(prefix)) {
      pendingFocusByOwnerAndWorktree.delete(key)
    }
  }
}

export function resetWebSessionFocusIntentForTests(): void {
  pendingFocusByOwnerAndWorktree.clear()
}
