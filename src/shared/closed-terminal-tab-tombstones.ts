/** Why this exists: the remote workspace snapshot cannot distinguish "never
 *  uploaded" from "closed by the user" by absence alone (see the trade
 *  documented in remote-workspace-session-merge.ts). A tombstone is the
 *  explicit close signal that lets the pull merge drop a tab the user closed
 *  without ever deleting a tab the host merely has not been told about.
 *  Tab ids are uuids and reopen (Cmd+Shift+T) mints a fresh id, so a closed
 *  id never legitimately reappears — keying on tabId is safe. */
export type ClosedTerminalTabTombstone = {
  closedAt: number
  worktreeId: string
}

export type ClosedTerminalTabTombstonesByTabId = Record<string, ClosedTerminalTabTombstone>

export const CLOSED_TAB_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
// Why a cap on top of the TTL: a heavy multi-workspace user can close far more
// tabs in 30 days than the snapshot should carry; newest-first keeps the ones
// still able to race a stale snapshot.
export const MAX_CLOSED_TAB_TOMBSTONES = 500

export function pruneClosedTerminalTabTombstones(
  map: ClosedTerminalTabTombstonesByTabId | undefined,
  now: number
): ClosedTerminalTabTombstonesByTabId {
  const entries = Object.entries(map ?? {}).filter(
    ([, tombstone]) => now - tombstone.closedAt <= CLOSED_TAB_TOMBSTONE_TTL_MS
  )
  entries.sort(([, a], [, b]) => b.closedAt - a.closedAt)
  return Object.fromEntries(entries.slice(0, MAX_CLOSED_TAB_TOMBSTONES))
}

export function recordClosedTerminalTabTombstone(
  map: ClosedTerminalTabTombstonesByTabId | undefined,
  tabId: string,
  worktreeId: string,
  now: number
): ClosedTerminalTabTombstonesByTabId {
  return pruneClosedTerminalTabTombstones({ ...map, [tabId]: { closedAt: now, worktreeId } }, now)
}

export function mergeClosedTerminalTabTombstones(
  a: ClosedTerminalTabTombstonesByTabId | undefined,
  b: ClosedTerminalTabTombstonesByTabId | undefined,
  now: number
): ClosedTerminalTabTombstonesByTabId {
  const merged: ClosedTerminalTabTombstonesByTabId = { ...a }
  for (const [tabId, tombstone] of Object.entries(b ?? {})) {
    const existing = merged[tabId]
    if (!existing || tombstone.closedAt > existing.closedAt) {
      merged[tabId] = tombstone
    }
  }
  return pruneClosedTerminalTabTombstones(merged, now)
}
