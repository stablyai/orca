import { z } from 'zod'

/** A client's own record that the user closed a terminal tab.
 *
 *  Why it must exist: absence alone cannot distinguish "the host was never told" from "the user
 *  closed it", so the merge keeps the tab — and a `pty.kill` that died on the transport means the
 *  host keeps listing it forever. This is the close signal that outlives the failed RPC.
 *  Safe because tab ids are uuids: a tombstoned id never legitimately returns. */
export type ClosedTerminalTabTombstone = {
  closedAt: number
  worktreeId: string
  /** Newest host revision seen for this tab's scope since the close. Retirement needs a STRICTLY
   *  newer snapshot that omits the tab, so a pull already in flight when the user closed cannot
   *  acknowledge a close it predates. */
  ackRevision?: number
}

export type ClosedTerminalTabTombstonesByTabId = Record<string, ClosedTerminalTabTombstone>

/** Colocated with the type so the two cannot drift. Must survive a relaunch — omitted from the
 *  session schema once, and zod silently stripped the map on every launch. */
export const closedTerminalTabTombstoneSchema = z.object({
  closedAt: z.number().int().nonnegative(),
  worktreeId: z.string().min(1),
  ackRevision: z.number().int().nonnegative().optional()
})

/** Backstops only — host acknowledgement is the normal exit. These cover a target the user never
 *  reconnects to, whose tombstones would otherwise never be retired. */
export const CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_CLOSED_TERMINAL_TAB_TOMBSTONES = 500

export function pruneClosedTerminalTabTombstones(
  map: ClosedTerminalTabTombstonesByTabId | undefined,
  now: number
): ClosedTerminalTabTombstonesByTabId {
  const entries = Object.entries(map ?? {}).filter(
    ([, tombstone]) => now - tombstone.closedAt <= CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS
  )
  entries.sort(([, a], [, b]) => b.closedAt - a.closedAt)
  return Object.fromEntries(entries.slice(0, MAX_CLOSED_TERMINAL_TAB_TOMBSTONES))
}

export function recordClosedTerminalTabTombstone(
  map: ClosedTerminalTabTombstonesByTabId | undefined,
  tabId: string,
  worktreeId: string,
  now: number
): ClosedTerminalTabTombstonesByTabId {
  return pruneClosedTerminalTabTombstones({ ...map, [tabId]: { closedAt: now, worktreeId } }, now)
}

function maxAckRevision(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) {
    return b
  }
  return b === undefined ? a : Math.max(a, b)
}

export type ClosedTerminalTabTombstoneAck = {
  tombstones: ClosedTerminalTabTombstonesByTabId | undefined
  /** Worktrees this snapshot actually carries a tab row for. A worktree the snapshot says nothing
   *  about — including one whose path never resolved to a local id — is not evidence of anything,
   *  so its tombstones are left untouched. */
  acknowledgedWorktreeIds: ReadonlySet<string>
  /** Every tab id the snapshot lists, across all worktrees: an id the host still carries anywhere
   *  has not been acknowledged, whichever worktree it now sits under. */
  hostKnownTabIds: ReadonlySet<string>
  hostRevision: number | undefined
  now: number
}

/** Retires tombstones the host has demonstrably seen, and stamps the rest with the revision that
 *  proved it had not yet.
 *
 *  Retirement takes a snapshot that both covers the tombstone's worktree and is strictly newer than
 *  the last one that did — one snapshot alone can be the pull that was already in flight when the
 *  user closed. Absence never deletes here: a snapshot with no revision, or one carrying no row for
 *  the worktree, retires nothing. */
export function reconcileClosedTerminalTabTombstones({
  tombstones,
  acknowledgedWorktreeIds,
  hostKnownTabIds,
  hostRevision,
  now
}: ClosedTerminalTabTombstoneAck): ClosedTerminalTabTombstonesByTabId {
  const pruned = pruneClosedTerminalTabTombstones(tombstones, now)
  if (hostRevision === undefined) {
    return pruned
  }
  const kept: ClosedTerminalTabTombstonesByTabId = {}
  for (const [tabId, tombstone] of Object.entries(pruned)) {
    if (!acknowledgedWorktreeIds.has(tombstone.worktreeId)) {
      kept[tabId] = tombstone
      continue
    }
    const observed = tombstone.ackRevision
    if (!hostKnownTabIds.has(tabId) && observed !== undefined && hostRevision > observed) {
      continue
    }
    kept[tabId] = { ...tombstone, ackRevision: maxAckRevision(observed, hostRevision) }
  }
  return kept
}
