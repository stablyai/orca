import { z } from 'zod'
import type { RuntimeSessionTabCloseReason } from './runtime-session-contracts'

const TERMINAL_TAB_CLOSE_REASONS = [
  'user',
  'cleanup',
  'pty-exit'
] as const satisfies readonly RuntimeSessionTabCloseReason[]

/** Main's record that a terminal tab was closed, written by its close transaction only.
 *
 *  Why it must exist: absence alone cannot distinguish "never told" from "closed", so without it a
 *  host snapshot or a late spawn commit brings the tab back, and an emptied workspace reads as one
 *  that was never initialized. Safe because tab ids are uuids: a closed id never legitimately
 *  returns. Nothing acknowledges it away; it dies by TTL or the per-host cap. */
export type ClosedTerminalTabTombstone = {
  closedAt: number
  worktreeId: string
  /** Absent on records an older build wrote, when only user closes were recorded. */
  reason?: RuntimeSessionTabCloseReason
}

export type ClosedTerminalTabTombstonesByTabId = Record<string, ClosedTerminalTabTombstone>

/** Colocated with the type so the two cannot drift. Must survive a relaunch — omitted from the
 *  session schema once, and zod silently stripped the map on every launch. */
export const closedTerminalTabTombstoneSchema = z.object({
  closedAt: z.number().int().nonnegative(),
  worktreeId: z.string().min(1),
  // Why catch: a reason a newer build adds must not cost this build the record itself.
  reason: z.enum(TERMINAL_TAB_CLOSE_REASONS).optional().catch(undefined)
})

/** Bounds on one host partition's map: pruned per partition, so one host's churn cannot evict
 *  another host's records. */
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
  record: Omit<ClosedTerminalTabTombstone, 'closedAt'>,
  now: number
): ClosedTerminalTabTombstonesByTabId {
  return pruneClosedTerminalTabTombstones({ ...map, [tabId]: { ...record, closedAt: now } }, now)
}

/** Whether a tab id was closed, by the record's own worktree. Object.hasOwn because the map is a
 *  plain object: `in` answers true for every Object.prototype key. */
export function hasClosedTerminalTabRecord(
  map: ClosedTerminalTabTombstonesByTabId | undefined,
  tabId: string,
  worktreeId?: string
): boolean {
  return (
    map !== undefined &&
    Object.hasOwn(map, tabId) &&
    (worktreeId === undefined || map[tabId]?.worktreeId === worktreeId)
  )
}

/** Emptied on purpose: the workspace's terminal row exists, is empty, and some tab in it was
 *  closed within the TTL. An empty row with no live record is unknown (legacy data, an expired
 *  record, or a writer that is not a close), so it reads as never initialized. Any record
 *  suffices, which is weaker than "the last removal was a close" until every membership shrink is
 *  a close. */
export function isTerminalWorkspaceEmptiedOnPurpose(
  state: {
    tabsByWorktree: Readonly<Record<string, readonly unknown[] | undefined>>
    closedTerminalTabTombstonesByTabId?: ClosedTerminalTabTombstonesByTabId
  },
  worktreeId: string,
  now = Date.now()
): boolean {
  return (
    Object.hasOwn(state.tabsByWorktree, worktreeId) &&
    (state.tabsByWorktree[worktreeId]?.length ?? 0) === 0 &&
    Object.values(state.closedTerminalTabTombstonesByTabId ?? {}).some(
      (record) =>
        record.worktreeId === worktreeId &&
        now - record.closedAt <= CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS
    )
  )
}
