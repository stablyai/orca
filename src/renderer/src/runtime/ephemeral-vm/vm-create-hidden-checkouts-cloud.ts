// Orca Cloud's part of the hidden-checkout filter: sandbox clones and other teams' sandboxes never list.
import { getExecutionHostIdFromWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  isPendingVmCheckout,
  type PendingVmCheckoutIndex
} from '../../../../shared/remote-runtime/ephemeral-vm-store/pending-vm-checkouts'

type CheckoutRow = { repoId: string; path: string; isMainWorktree?: boolean; hostId?: string }

/**
 * What lists filter by: this window's pending VM checkouts and every other window's, plus the
 * Orca Cloud hosts lists scope (withOrcaCloudHosts).
 */
export type HiddenVmCheckouts = PendingVmCheckoutIndex & {
  /** Active-team Orca Cloud hosts: their primary checkout (the sandbox's clone) never lists. */
  readonly primaryHostIds?: ReadonlySet<string>
  /** Paired Orca Cloud hosts: their primary checkout hides only beside a linked worktree of its repo. */
  readonly pairedHostIds?: ReadonlySet<string>
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
  hosts: {
    primaryHostIds: ReadonlySet<string>
    pairedHostIds?: ReadonlySet<string>
    hiddenHostIds: ReadonlySet<string>
  }
): HiddenVmCheckouts {
  const pairedHostIds = hosts.pairedHostIds ?? new Set<string>()
  return hosts.primaryHostIds.size === 0 &&
    pairedHostIds.size === 0 &&
    hosts.hiddenHostIds.size === 0
    ? checkouts
    : {
        ...checkouts,
        primaryHostIds: hosts.primaryHostIds,
        pairedHostIds,
        hiddenHostIds: hosts.hiddenHostIds
      }
}

function isHostScoped(checkouts: HiddenVmCheckouts): boolean {
  return Boolean(
    checkouts.primaryHostIds?.size || checkouts.pairedHostIds?.size || checkouts.hiddenHostIds?.size
  )
}

export function hidesNothing(checkouts: HiddenVmCheckouts): boolean {
  return checkouts.keys.size === 0 && !isHostScoped(checkouts)
}

/** Host-scoped rows can sit under any repo; pending checkouts only under theirs. */
export function hiddenVmRepoIds(
  checkouts: HiddenVmCheckouts,
  worktreesByRepo: Record<string, unknown>
): Iterable<string> {
  return isHostScoped(checkouts) ? Object.keys(worktreesByRepo) : checkouts.repoIds
}

function hostRepoKey(hostId: string, repoId: string): string {
  return `${hostId}\0${repoId}`
}

/** Paired host+repo pairs that list a linked worktree, whose primary (the base clone) then hides. */
function pairedLinkedHostRepos(
  checkouts: HiddenVmCheckouts,
  rows: Iterable<{ row: CheckoutRow; hostId: string | undefined }>
): ReadonlySet<string> {
  const linked = new Set<string>()
  if (!checkouts.pairedHostIds?.size) {
    return linked
  }
  for (const { row, hostId } of rows) {
    if (hostId && row.isMainWorktree !== true && checkouts.pairedHostIds.has(hostId)) {
      linked.add(hostRepoKey(hostId, row.repoId))
    }
  }
  return linked
}

function isHiddenCheckout(
  checkouts: HiddenVmCheckouts,
  row: CheckoutRow,
  hostId: string | undefined,
  pairedLinked: ReadonlySet<string>
): boolean {
  if (hostId && checkouts.hiddenHostIds?.has(hostId)) {
    return true
  }
  if (row.isMainWorktree === true && hostId && checkouts.primaryHostIds?.has(hostId)) {
    return true
  }
  if (row.isMainWorktree === true && hostId && pairedLinked.has(hostRepoKey(hostId, row.repoId))) {
    return true
  }
  return checkouts.keys.size > 0 && isPendingVmCheckout(checkouts, row)
}

/** Whether a sidebar worktree row hides, judged against its sibling rows. */
export function hiddenWorktreeFilter(
  checkouts: HiddenVmCheckouts,
  worktrees: readonly CheckoutRow[]
): (worktree: CheckoutRow) => boolean {
  const pairedLinked = pairedLinkedHostRepos(
    checkouts,
    worktrees.map((row) => ({ row, hostId: row.hostId }))
  )
  return (worktree) => isHiddenCheckout(checkouts, worktree, worktree.hostId, pairedLinked)
}

/** Whether one of main's keyed rows hides; paired-server rows carry their host only in the key. */
export function hiddenRowFilter<K, V extends CheckoutRow>(
  checkouts: HiddenVmCheckouts,
  rows: ReadonlyMap<K, V>
): (key: K, row: V) => boolean {
  const hostOf = (key: K, row: V): string | undefined =>
    row.hostId ??
    (typeof key === 'string' ? getExecutionHostIdFromWorktreeHostIdentity(key) : undefined)
  const pairedLinked = pairedLinkedHostRepos(
    checkouts,
    [...rows].map(([key, row]) => ({ row, hostId: hostOf(key, row) }))
  )
  return (key, row) => isHiddenCheckout(checkouts, row, hostOf(key, row), pairedLinked)
}
