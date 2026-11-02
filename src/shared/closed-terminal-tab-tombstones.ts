import { z } from 'zod'
import type { RuntimeSessionTabCloseReason } from './runtime-session-contracts'

const TERMINAL_TAB_CLOSE_REASONS = [
  'user',
  'cleanup',
  'pty-exit'
] as const satisfies readonly RuntimeSessionTabCloseReason[]

/** Only close transactions record tombstones: absence cannot distinguish unseen from closed, letting late spawns/snapshots resurrect tabs. UUIDs never return legitimately; retain until TTL, per-host cap or workspace session removal. */
export type ClosedTerminalTabTombstone = {
  closedAt: number
  worktreeId: string
  /** Absent on records an older build wrote, when only user closes were recorded. */
  reason?: RuntimeSessionTabCloseReason
}

export type ClosedTerminalTabTombstonesByTabId = Record<string, ClosedTerminalTabTombstone>

/** Colocate persistence schema with type; omitting it once let zod silently strip tombstones on every relaunch. */
export const closedTerminalTabTombstoneSchema = z.object({
  closedAt: z.number().int().nonnegative(),
  worktreeId: z.string().min(1),
  // Why catch: a reason a newer build adds must not cost this build the record itself.
  reason: z.enum(TERMINAL_TAB_CLOSE_REASONS).optional().catch(undefined)
})

/** Prune within host partitions so one host’s churn cannot evict another’s records. */
export const CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_CLOSED_TERMINAL_TAB_TOMBSTONES = 500

/** Also bounds main's closed-pane records (closed-terminal-panes.ts), under the same TTL and cap. */
export function pruneClosedTerminalTabTombstones<Closed extends { closedAt: number }>(
  map: Record<string, Closed> | undefined,
  now: number
): Record<string, Closed> {
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

/** Check TTL even before prune-on-close runs; require the owning workspace and Object.hasOwn so prototype keys cannot prove closure. */
export function hasClosedTerminalTabRecord(
  map: ClosedTerminalTabTombstonesByTabId | undefined,
  tabId: string,
  worktreeId?: string,
  now = Date.now()
): boolean {
  const record = map !== undefined && Object.hasOwn(map, tabId) ? map[tabId] : undefined
  return (
    record !== undefined &&
    now - record.closedAt <= CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS &&
    (worktreeId === undefined || record.worktreeId === worktreeId)
  )
}

/** An empty terminal row plus any live close record means intentionally emptied. Without a record it is unknown/never initialized; this is weaker than proving the last removal was a close until every shrink records one. */
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
