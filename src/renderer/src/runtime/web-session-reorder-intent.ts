// Keep optimistic per-group order against pre-move snapshots. Clear on host confirmation, membership change or TTL so rejected moves cannot pin stale order.

const REORDER_INTENT_TTL_MS = 10_000
export const MAX_REORDER_INTENT_PARTITIONS = 512
export const MAX_REORDER_INTENTS_PER_PARTITION = 256

type ReorderIntent = { order: string[]; recordedAt: number }

import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'

const pendingReorderByOwnerAndWorktree = new Map<string, Map<string, ReorderIntent>>()

function reorderIntentPartitionKey(owner: WebSessionIntentOwner, worktreeId: string): string {
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}`
}

function sameMembership(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function recordWebSessionReorderIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  groupId: string,
  order: readonly string[],
  now: number
): void {
  if (!worktreeId || !groupId || order.length === 0) {
    return
  }
  const partitionKey = reorderIntentPartitionKey(owner, worktreeId)
  let byGroup = pendingReorderByOwnerAndWorktree.get(partitionKey)
  if (!byGroup) {
    byGroup = new Map()
    pendingReorderByOwnerAndWorktree.set(partitionKey, byGroup)
  }
  byGroup.delete(groupId)
  byGroup.set(groupId, { order: [...order], recordedAt: now })
  while (byGroup.size > MAX_REORDER_INTENTS_PER_PARTITION) {
    const oldest = byGroup.keys().next()
    if (oldest.done || oldest.value === groupId) {
      break
    }
    byGroup.delete(oldest.value)
  }
  pendingReorderByOwnerAndWorktree.delete(partitionKey)
  pendingReorderByOwnerAndWorktree.set(partitionKey, byGroup)
  while (pendingReorderByOwnerAndWorktree.size > MAX_REORDER_INTENT_PARTITIONS) {
    const oldest = pendingReorderByOwnerAndWorktree.keys().next()
    if (oldest.done || oldest.value === partitionKey) {
      break
    }
    pendingReorderByOwnerAndWorktree.delete(oldest.value)
  }
}

/** Pending order wins only while membership matches; confirmation, membership changes or expiry release the intent. */
export function resolveWebSessionReorderedOrder(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  groupId: string,
  hostOrder: string[],
  now: number
): string[] {
  const partitionKey = reorderIntentPartitionKey(owner, worktreeId)
  const byGroup = pendingReorderByOwnerAndWorktree.get(partitionKey)
  const intent = byGroup?.get(groupId)
  if (!intent) {
    return hostOrder
  }
  const clear = (): void => {
    byGroup!.delete(groupId)
    if (byGroup!.size === 0) {
      pendingReorderByOwnerAndWorktree.delete(partitionKey)
    }
  }
  if (now - intent.recordedAt > REORDER_INTENT_TTL_MS) {
    clear()
    return hostOrder
  }
  // Changed membership is newer truth; discard ambiguous pending order.
  if (!sameMembership(intent.order, hostOrder)) {
    clear()
    return hostOrder
  }
  if (sameOrder(intent.order, hostOrder)) {
    clear()
    return hostOrder
  }
  return [...intent.order]
}

export function clearWebSessionReorderIntentsForWorktree(
  owner: WebSessionIntentOwner,
  worktreeId: string
): void {
  pendingReorderByOwnerAndWorktree.delete(reorderIntentPartitionKey(owner, worktreeId))
}

export function clearWebSessionReorderIntent(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  groupId: string
): void {
  const partitionKey = reorderIntentPartitionKey(owner, worktreeId)
  const byGroup = pendingReorderByOwnerAndWorktree.get(partitionKey)
  byGroup?.delete(groupId)
  if (byGroup?.size === 0) {
    pendingReorderByOwnerAndWorktree.delete(partitionKey)
  }
}

export function clearWebSessionReorderIntentsForOwner(owner: WebSessionIntentOwner): void {
  const prefix = `${webSessionIntentOwnerKey(owner)}\0`
  for (const key of pendingReorderByOwnerAndWorktree.keys()) {
    if (key.startsWith(prefix)) {
      pendingReorderByOwnerAndWorktree.delete(key)
    }
  }
}

export function resetWebSessionReorderIntentForTests(): void {
  pendingReorderByOwnerAndWorktree.clear()
}
