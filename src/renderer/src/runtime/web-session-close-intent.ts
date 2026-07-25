// Why: closing a remote tab prunes the local mirror immediately for responsiveness, so stale pre-close snapshots must not rematerialize it.

import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'

const CLOSE_INTENT_TTL_MS = 10_000

type CloseIntent = { recordedAt: number }

const pendingCloseByOwnerAndWorktree = new Map<string, Map<string, CloseIntent>>()

function closeIntentPartitionKey(owner: WebSessionIntentOwner, worktreeId: string): string {
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}`
}

export function recordWebSessionCloseIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  now: number
): void {
  const trimmed = hostTabId.trim()
  if (!worktreeId || !trimmed) {
    return
  }
  const partitionKey = closeIntentPartitionKey(owner, worktreeId)
  let byTab = pendingCloseByOwnerAndWorktree.get(partitionKey)
  if (!byTab) {
    byTab = new Map()
    pendingCloseByOwnerAndWorktree.set(partitionKey, byTab)
  }
  byTab.set(trimmed, { recordedAt: now })
}

export function isWebSessionCloseIntentPending(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string,
  now: number
): boolean {
  const partitionKey = closeIntentPartitionKey(owner, worktreeId)
  const byTab = pendingCloseByOwnerAndWorktree.get(partitionKey)
  const intent = byTab?.get(hostTabId)
  if (!intent) {
    return false
  }
  if (now - intent.recordedAt > CLOSE_INTENT_TTL_MS) {
    byTab!.delete(hostTabId)
    if (byTab!.size === 0) {
      pendingCloseByOwnerAndWorktree.delete(partitionKey)
    }
    return false
  }
  return true
}

export function reconcileWebSessionCloseIntents(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  presentHostTabIds: ReadonlySet<string>
): void {
  const partitionKey = closeIntentPartitionKey(owner, worktreeId)
  const byTab = pendingCloseByOwnerAndWorktree.get(partitionKey)
  if (!byTab) {
    return
  }
  for (const hostTabId of byTab.keys()) {
    if (!presentHostTabIds.has(hostTabId)) {
      byTab.delete(hostTabId)
    }
  }
  if (byTab.size === 0) {
    pendingCloseByOwnerAndWorktree.delete(partitionKey)
  }
}

export function clearWebSessionCloseIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string
): void {
  const partitionKey = closeIntentPartitionKey(owner, worktreeId)
  const byTab = pendingCloseByOwnerAndWorktree.get(partitionKey)
  byTab?.delete(hostTabId)
  if (byTab?.size === 0) {
    pendingCloseByOwnerAndWorktree.delete(partitionKey)
  }
}

export function clearWebSessionCloseIntentsForWorktree(
  owner: WebSessionIntentOwner,
  worktreeId: string
): void {
  pendingCloseByOwnerAndWorktree.delete(closeIntentPartitionKey(owner, worktreeId))
}

export function clearWebSessionCloseIntentsForOwner(owner: WebSessionIntentOwner): void {
  const prefix = `${webSessionIntentOwnerKey(owner)}\0`
  for (const key of pendingCloseByOwnerAndWorktree.keys()) {
    if (key.startsWith(prefix)) {
      pendingCloseByOwnerAndWorktree.delete(key)
    }
  }
}

export function resetWebSessionCloseIntentForTests(): void {
  pendingCloseByOwnerAndWorktree.clear()
}
