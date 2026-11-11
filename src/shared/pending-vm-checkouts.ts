import * as z from 'zod'
import { normalizeRuntimePathForComparison } from './cross-platform-path'

/** A VM's primary checkout, registered on its host before the create that owns it finishes. */
export type PendingVmCheckout = { repoId: string; path: string }

export const PENDING_VM_CHECKOUTS_CHANGED_CHANNEL = 'ephemeralVm:pendingCheckoutsChanged'
/** Bounds what one window may publish; a window runs only a handful of creates at once. */
export const PENDING_VM_CHECKOUTS_LIMIT = 64

/** What lists filter by; `repoIds` lets most rows skip building a path key. */
export type PendingVmCheckoutIndex = {
  readonly repoIds: ReadonlySet<string>
  readonly keys: ReadonlySet<string>
}

export const EMPTY_PENDING_VM_CHECKOUT_INDEX: PendingVmCheckoutIndex = {
  repoIds: new Set(),
  keys: new Set()
}

function checkoutKey(repoId: string, path: string): string {
  return `${repoId}\0${normalizeRuntimePathForComparison(path)}`
}

export function indexPendingVmCheckouts(
  checkouts: Iterable<PendingVmCheckout>
): PendingVmCheckoutIndex {
  const list = [...checkouts]
  if (list.length === 0) {
    return EMPTY_PENDING_VM_CHECKOUT_INDEX
  }
  return {
    repoIds: new Set(list.map((checkout) => checkout.repoId)),
    keys: new Set(list.map((checkout) => checkoutKey(checkout.repoId, checkout.path)))
  }
}

/** A row is the VM checkout a create in progress has not adopted yet. Linked worktrees never are. */
export function isPendingVmCheckout(
  index: PendingVmCheckoutIndex,
  row:
    | { repoId?: unknown; path?: unknown; isMainWorktree?: unknown }
    | Readonly<Record<string, unknown>>
): boolean {
  const repoId = 'repoId' in row ? row.repoId : undefined
  const path = 'path' in row ? row.path : undefined
  return (
    typeof repoId === 'string' &&
    typeof path === 'string' &&
    !('isMainWorktree' in row && row.isMainWorktree === false) &&
    index.repoIds.has(repoId) &&
    index.keys.has(checkoutKey(repoId, path))
  )
}

const PendingVmCheckoutSchema = z.object({ repoId: z.string(), path: z.string() })

/** Untrusted IPC input: keep only well-formed entries, bounded. */
export function parsePendingVmCheckouts(value: unknown): PendingVmCheckout[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.slice(0, PENDING_VM_CHECKOUTS_LIMIT).flatMap((entry: unknown) => {
    const parsed = PendingVmCheckoutSchema.safeParse(entry)
    return parsed.success ? [{ repoId: parsed.data.repoId, path: parsed.data.path }] : []
  })
}
