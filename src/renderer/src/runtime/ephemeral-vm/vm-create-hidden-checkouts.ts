import type { SidebarFeedDomains } from '../../../../shared/sidebar-list/sidebar-feed-domains'
import { getExecutionHostIdFromWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  indexPendingVmCheckouts,
  isPendingVmCheckout,
  type PendingVmCheckout,
  type PendingVmCheckoutIndex
} from '../../../../shared/pending-vm-checkouts'

type CheckoutRow = {
  repoId: string
  path: string
  isMainWorktree?: boolean
  hostId?: string
}

/**
 * What lists filter by: this window's pending VM checkouts and every other window's, plus the
 * Orca Cloud hosts lists scope (withOrcaCloudHosts).
 */
export type HiddenVmCheckouts = PendingVmCheckoutIndex & {
  /** Active-team Orca Cloud hosts: their primary checkout (the sandbox's clone) never lists. */
  readonly primaryHostIds?: ReadonlySet<string>
  /** Orca Cloud hosts of another team, or of no team we can resolve: every row hides. */
  readonly hiddenHostIds?: ReadonlySet<string>
}

/**
 * Why: each Orca Cloud workspace is its own sandbox whose clone is registered as the project there,
 * and the workspace is a worktree beside it (orca-worktree mode). That clone is scaffolding, not a
 * workspace: listed, every cloud workspace added another identical "<default branch> primary ·
 * Orca Cloud" row to its project. Another team's sandbox lists nothing at all.
 */
export function withOrcaCloudHosts(
  checkouts: HiddenVmCheckouts,
  hosts: { primaryHostIds: ReadonlySet<string>; hiddenHostIds: ReadonlySet<string> }
): HiddenVmCheckouts {
  return hosts.primaryHostIds.size === 0 && hosts.hiddenHostIds.size === 0
    ? checkouts
    : { ...checkouts, primaryHostIds: hosts.primaryHostIds, hiddenHostIds: hosts.hiddenHostIds }
}

function hidesNothing(checkouts: HiddenVmCheckouts): boolean {
  return (
    checkouts.keys.size === 0 && !checkouts.primaryHostIds?.size && !checkouts.hiddenHostIds?.size
  )
}

function isHiddenCheckout(
  checkouts: HiddenVmCheckouts,
  row: CheckoutRow,
  hostId: string | undefined = row.hostId
): boolean {
  if (hostId && checkouts.hiddenHostIds?.has(hostId)) {
    return true
  }
  if (row.isMainWorktree === true && hostId && checkouts.primaryHostIds?.has(hostId)) {
    return true
  }
  return checkouts.keys.size > 0 && isPendingVmCheckout(checkouts, row)
}

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

/** The window's sidebar list without hidden VM checkouts, cloud clones and other teams' sandboxes. */
export function withoutHiddenVmWorktrees<W extends CheckoutRow>(
  worktrees: W[],
  checkouts: HiddenVmCheckouts
): W[] {
  if (hidesNothing(checkouts)) {
    return worktrees
  }
  const kept = worktrees.filter((worktree) => !isHiddenCheckout(checkouts, worktree))
  return kept.length === worktrees.length ? worktrees : kept
}

/** Per-repo lists without hidden checkouts; the same object when nothing matches. */
export function withoutHiddenVmWorktreesByRepo<W extends CheckoutRow>(
  worktreesByRepo: Record<string, W[]>,
  checkouts: HiddenVmCheckouts
): Record<string, W[]> {
  if (hidesNothing(checkouts)) {
    return worktreesByRepo
  }
  const hostScoped = Boolean(checkouts.primaryHostIds?.size || checkouts.hiddenHostIds?.size)
  let next: Record<string, W[]> | null = null
  // Host-scoped rows can sit under any repo; pending checkouts only under theirs.
  const repoIds = hostScoped ? Object.keys(worktreesByRepo) : checkouts.repoIds
  for (const repoId of repoIds) {
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

function withoutHiddenRows<K extends string, V extends CheckoutRow>(
  rows: ReadonlyMap<K, V>,
  checkouts: HiddenVmCheckouts
): ReadonlyMap<K, V> {
  let kept: Map<K, V> | null = null
  for (const [key, row] of rows) {
    // Paired-server rows carry their host only in the host-qualified key.
    const hostId = row.hostId ?? getExecutionHostIdFromWorktreeHostIdentity(key)
    if (isHiddenCheckout(checkouts, row, hostId)) {
      kept ??= new Map(rows)
      kept.delete(key)
    }
  }
  return kept ?? rows
}

/** Main's rows without hidden VM checkouts, cloud clones and other teams' sandboxes. */
export function withoutHiddenVmCheckouts(
  domains: SidebarFeedDomains,
  checkouts: HiddenVmCheckouts
): SidebarFeedDomains {
  if (hidesNothing(checkouts)) {
    return domains
  }
  const workspaces = withoutHiddenRows(domains.workspaces, checkouts)
  const pairedServerRows = withoutHiddenRows(domains.pairedServerRows, checkouts)
  return workspaces === domains.workspaces && pairedServerRows === domains.pairedServerRows
    ? domains
    : { ...domains, workspaces, pairedServerRows }
}
