// Why: a remote tab create/activate is the ONE case where the session snapshot's
// activeTabId reflects genuine user focus intent. Status-echo snapshots (e.g. an
// agent "thinking" during a run) also set activeTabId but must NOT steal focus
// (#5435). The snapshot can't distinguish these, so the client records its own
// activation intent here: the reconcile only follows the snapshot's active tab
// when it matches a pending intent the client itself initiated.
//
// Keyed by worktree id → the host session tab id the client expects to focus.
// The intent persists until a snapshot matches it (surviving racing/duplicate
// snapshots, unlike a transient per-snapshot flag).

import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'

const pendingFocusByOwnerAndWorktree = new Map<string, string>()

function focusIntentPartitionKey(owner: WebSessionIntentOwner, worktreeId: string): string {
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}`
}

export function recordWebSessionFocusIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string
): void {
  const trimmed = hostTabId.trim()
  if (!worktreeId || !trimmed) {
    return
  }
  pendingFocusByOwnerAndWorktree.set(focusIntentPartitionKey(owner, worktreeId), trimmed)
}

export function peekWebSessionFocusIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string
): string | null {
  return pendingFocusByOwnerAndWorktree.get(focusIntentPartitionKey(owner, worktreeId)) ?? null
}

export function clearWebSessionFocusIntent(owner: WebSessionIntentOwner, worktreeId: string): void {
  pendingFocusByOwnerAndWorktree.delete(focusIntentPartitionKey(owner, worktreeId))
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
