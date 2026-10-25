// Why: closing a remote tab prunes the local mirror immediately for responsiveness, so stale pre-close snapshots must not rematerialize it.

import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'

// Outlast close RPC timeout so snapshot queries cannot evict intent before tab_not_found makes it durable (#9194).
const CLOSE_INTENT_ANSWER_GRACE_MS = 5_000
export const WEB_SESSION_CLOSE_INTENT_TTL_MS =
  WEB_SESSION_TAB_RPC_TIMEOUT_MS + CLOSE_INTENT_ANSWER_GRACE_MS
export const MAX_WEB_SESSION_CLOSE_INTENT_PARTITIONS = 512

type CloseIntent = { recordedAt: number; durable: boolean }

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
    while (pendingCloseByOwnerAndWorktree.size >= MAX_WEB_SESSION_CLOSE_INTENT_PARTITIONS) {
      const oldest = pendingCloseByOwnerAndWorktree.keys().next()
      if (oldest.done || oldest.value === partitionKey) {
        break
      }
      pendingCloseByOwnerAndWorktree.delete(oldest.value)
    }
    pendingCloseByOwnerAndWorktree.set(partitionKey, byTab)
  }
  byTab.set(trimmed, { recordedAt: now, durable: byTab.get(trimmed)?.durable === true })
}

// Definitive tab_not_found can coexist with stale republished surfaces (#9194); no TTL or unclosable panes return. Clear when a snapshot omits the surface so recovered tabs are not suppressed forever.
export function makeWebSessionCloseIntentDurable(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string
): void {
  const intent = pendingCloseByOwnerAndWorktree
    .get(closeIntentPartitionKey(owner, worktreeId))
    ?.get(hostTabId)
  if (intent) {
    intent.durable = true
  }
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
  if (!intent.durable && now - intent.recordedAt > WEB_SESSION_CLOSE_INTENT_TTL_MS) {
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
