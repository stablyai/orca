import type { SidebarFeedDomains } from '../../../../shared/sidebar-list/sidebar-feed-domains'
import {
  indexPendingVmCheckouts,
  isPendingVmCheckout,
  type PendingVmCheckout,
  type PendingVmCheckoutIndex
} from '../../../../shared/pending-vm-checkouts'

type CheckoutRow = { repoId: string; path: string; isMainWorktree?: boolean }

// Upper bound for a cleaned-up VM's rows to leave the lists (its host is retired asynchronously).
const HIDDEN_AFTER_CLEANUP_MS = 60_000

// Keyed per hide, not per creation: a retry re-provisions under the same creation id while the
// previous attempt's cleaned-up VM may still be listed.
let hides = new Map<number, PendingVmCheckout>()
const activeHideByCreation = new Map<string, number>()
const cleanedHides = new Set<number>()
let nextHideId = 1
/** The other windows' sets as main last sent them; this window's own live in `hides`. */
let otherWindows: PendingVmCheckout[] = []
let hidden: PendingVmCheckoutIndex = indexPendingVmCheckouts([])
let detachMain: (() => void) | null = null
const listeners = new Set<() => void>()

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key))
}

function republish(): void {
  const next = indexPendingVmCheckouts([...hides.values(), ...otherWindows])
  if (sameKeys(next.keys, hidden.keys)) {
    return
  }
  hidden = next
  listeners.forEach((listener) => listener())
}

function publish(next: Map<number, PendingVmCheckout>): void {
  hides = next
  // Main holds the source of truth for other windows and the paired phone's host lists.
  if (typeof window !== 'undefined') {
    window.api?.ephemeralVm?.publishPendingCheckouts?.([...next.values()])
  }
  republish()
}

function attachMain(): void {
  const api = typeof window === 'undefined' ? undefined : window.api?.ephemeralVm
  if (detachMain || !api?.onPendingCheckoutsChanged) {
    return
  }
  // A reloaded window starts with no creates; drop whatever its previous page left in main.
  if (hides.size === 0) {
    api.publishPendingCheckouts?.([])
  }
  detachMain = api.onPendingCheckoutsChanged((checkouts) => {
    otherWindows = checkouts
    republish()
  })
  void api
    .listPendingCheckouts?.()
    .then((checkouts) => {
      otherWindows = checkouts
      republish()
    })
    .catch(() => {})
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
export function hideVmCreateCheckout(creationId: string, checkout: PendingVmCheckout): void {
  const hideId = nextHideId++
  activeHideByCreation.set(creationId, hideId)
  publish(new Map(hides).set(hideId, { repoId: checkout.repoId, path: checkout.path }))
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
  attachMain()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readHiddenVmCheckouts(): PendingVmCheckoutIndex {
  return hidden
}

/** The window's sidebar list without the primary checkouts of VMs whose creates are in progress. */
export function withoutHiddenVmWorktrees<W extends CheckoutRow>(
  worktrees: W[],
  checkouts: PendingVmCheckoutIndex
): W[] {
  if (checkouts.keys.size === 0) {
    return worktrees
  }
  const kept = worktrees.filter((worktree) => !isPendingVmCheckout(checkouts, worktree))
  return kept.length === worktrees.length ? worktrees : kept
}

/** Per-repo lists without pending VM checkouts; the same object when nothing matches. */
export function withoutHiddenVmWorktreesByRepo<W extends CheckoutRow>(
  worktreesByRepo: Record<string, W[]>,
  checkouts: PendingVmCheckoutIndex
): Record<string, W[]> {
  if (checkouts.keys.size === 0) {
    return worktreesByRepo
  }
  let next: Record<string, W[]> | null = null
  for (const repoId of checkouts.repoIds) {
    const list = worktreesByRepo[repoId]
    if (!list) {
      continue
    }
    const kept = withoutHiddenVmWorktrees(list, checkouts)
    if (kept !== list) {
      next ??= { ...worktreesByRepo }
      next[repoId] = kept
    }
  }
  return next ?? worktreesByRepo
}

function withoutHiddenRows<K, V extends CheckoutRow>(
  rows: ReadonlyMap<K, V>,
  checkouts: PendingVmCheckoutIndex
): ReadonlyMap<K, V> {
  let kept: Map<K, V> | null = null
  for (const [key, row] of rows) {
    if (isPendingVmCheckout(checkouts, row)) {
      kept ??= new Map(rows)
      kept.delete(key)
    }
  }
  return kept ?? rows
}

/** Main's rows without the primary checkouts of VMs whose creates are still in progress. */
export function withoutHiddenVmCheckouts(
  domains: SidebarFeedDomains,
  checkouts: PendingVmCheckoutIndex
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
