import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'

/** A VM's primary checkout, registered on its host before the create that owns it finishes. */
export type HiddenVmCheckout = { repoId: string; path: string }
type CheckoutRow = { repoId: string; path: string; isMainWorktree?: boolean }

/** What the sidebar filters by; `repoIds` lets most rows skip building a path key. */
export type HiddenVmCheckouts = {
  readonly repoIds: ReadonlySet<string>
  readonly keys: ReadonlySet<string>
}

// Upper bound for a cleaned-up VM's rows to leave the lists (its host is retired asynchronously).
const HIDDEN_AFTER_CLEANUP_MS = 60_000

const EMPTY: HiddenVmCheckouts = { repoIds: new Set(), keys: new Set() }
type Hide = HiddenVmCheckout & { key: string }
// Keyed per hide, not per creation: a retry re-provisions under the same creation id while the
// previous attempt's cleaned-up VM may still be listed.
let hides = new Map<number, Hide>()
const activeHideByCreation = new Map<string, number>()
const cleanedHides = new Set<number>()
let nextHideId = 1
let hidden: HiddenVmCheckouts = EMPTY
const listeners = new Set<() => void>()

function checkoutKey(repoId: string, path: string): string {
  return `${repoId}\0${normalizeRuntimePathForComparison(path)}`
}

function publish(next: Map<number, Hide>): void {
  hides = next
  const values = [...next.values()]
  hidden =
    values.length === 0
      ? EMPTY
      : {
          repoIds: new Set(values.map((hide) => hide.repoId)),
          keys: new Set(values.map((hide) => hide.key))
        }
  listeners.forEach((listener) => listener())
}

function removeHide(hideId: number): void {
  cleanedHides.delete(hideId)
  if (!hides.has(hideId)) {
    return
  }
  const next = new Map(hides)
  next.delete(hideId)
  publish(next)
}

/**
 * Why: a VM create registers the VM's project before its checks run and before the checkout is
 * adopted or a worktree is made; the pending row stands for it until the create finishes.
 */
export function hideVmCreateCheckout(creationId: string, checkout: HiddenVmCheckout): void {
  const hideId = nextHideId++
  activeHideByCreation.set(creationId, hideId)
  publish(
    new Map(hides).set(hideId, { ...checkout, key: checkoutKey(checkout.repoId, checkout.path) })
  )
}

/** The create finished: the checkout is now a workspace (or its project) the sidebar may list. */
export function releaseVmCreateCheckout(creationId: string): void {
  const hideId = activeHideByCreation.get(creationId)
  if (hideId === undefined) {
    return
  }
  activeHideByCreation.delete(creationId)
  removeHide(hideId)
}

/**
 * A failed or cancelled create's VM cleanup finished. A VM that could not be cleaned up shows again
 * so the user can remove it; a cleaned-up one stays hidden while its rows leave the lists. A later
 * cleanup of the same create (a cancel racing the create) cannot un-hide a VM already cleaned up.
 */
export function settleVmCreateCheckoutAfterCleanup(creationId: string, cleanedUp: boolean): void {
  const hideId = activeHideByCreation.get(creationId)
  if (hideId === undefined || cleanedHides.has(hideId)) {
    return
  }
  if (!cleanedUp) {
    releaseVmCreateCheckout(creationId)
    return
  }
  activeHideByCreation.delete(creationId)
  cleanedHides.add(hideId)
  setTimeout(() => removeHide(hideId), HIDDEN_AFTER_CLEANUP_MS)
}

export function subscribeHiddenVmCheckouts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readHiddenVmCheckouts(): HiddenVmCheckouts {
  return hidden
}

function isHidden(checkouts: HiddenVmCheckouts, row: CheckoutRow): boolean {
  return (
    row.isMainWorktree !== false &&
    checkouts.repoIds.has(row.repoId) &&
    checkouts.keys.has(checkoutKey(row.repoId, row.path))
  )
}

/** The window's sidebar list without the primary checkouts of VMs whose creates are in progress. */
export function withoutHiddenVmWorktrees<W extends CheckoutRow>(
  worktrees: W[],
  checkouts: HiddenVmCheckouts
): W[] {
  if (checkouts.keys.size === 0) {
    return worktrees
  }
  const kept = worktrees.filter((worktree) => !isHidden(checkouts, worktree))
  return kept.length === worktrees.length ? worktrees : kept
}

function withoutHiddenRows<K, V extends CheckoutRow>(
  rows: ReadonlyMap<K, V>,
  checkouts: HiddenVmCheckouts
): ReadonlyMap<K, V> {
  let kept: Map<K, V> | null = null
  for (const [key, row] of rows) {
    if (isHidden(checkouts, row)) {
      kept ??= new Map(rows)
      kept.delete(key)
    }
  }
  return kept ?? rows
}

/** Main's rows without the primary checkouts of VMs whose creates are still in progress. */
export function withoutHiddenVmCheckouts(
  domains: SidebarFeedDomains,
  checkouts: HiddenVmCheckouts
): SidebarFeedDomains {
  if (checkouts.keys.size === 0) {
    return domains
  }
  const workspaces = withoutHiddenRows(domains.workspaces, checkouts)
  const pairedServerRows = withoutHiddenRows(domains.pairedServerRows, checkouts)
  return workspaces === domains.workspaces && pairedServerRows === domains.pairedServerRows
    ? domains
    : { ...domains, workspaces, pairedServerRows }
}
