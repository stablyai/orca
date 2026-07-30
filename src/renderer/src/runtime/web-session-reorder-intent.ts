// Why: reordering a remote tab updates the local group order immediately for
// responsiveness, then asks the host to move the tab. But an in-flight host
// snapshot (published before the host processed the move, or the move RPC's own
// pre-move subscribe replay) can still carry the OLD order and arrive after the
// local reorder — the reconcile then overwrites the optimistic order, snapping
// the tab back to where it was. Close has the same hazard and guards it with a
// close-intent; reorder had no equivalent, so it always lost the race.
//
// The client records its intended local tab order per group here. The reconcile
// substitutes it for the host order until a snapshot confirms the move (host
// order matches the intent) or the group membership changes (a newer truth), at
// which point the intent clears. A TTL guards a never-confirmed move (e.g. a
// rejected RPC) from pinning a stale order forever.

const REORDER_INTENT_TTL_MS = 10_000

type ReorderIntent = { order: string[]; recordedAt: number }

// worktreeId -> (groupId -> intent)
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
  byGroup.set(groupId, { order: [...order], recordedAt: now })
}

/**
 * Resolve the local tab order a reconcile should apply for a group. When the
 * client has a pending reorder for this group whose membership still matches the
 * host order, the intended order wins (suppressing a stale pre-move snapshot).
 * The intent clears once the host confirms it (orders match), the membership
 * diverges (add/close changed the truth), or the TTL lapses.
 */
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
  // Why: a membership change (tab added/closed elsewhere) is a newer truth than
  // a pending reorder — defer to the host and drop the now-ambiguous intent.
  if (!sameMembership(intent.order, hostOrder)) {
    clear()
    return hostOrder
  }
  if (sameOrder(intent.order, hostOrder)) {
    // Host confirmed the move; nothing left to suppress.
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
