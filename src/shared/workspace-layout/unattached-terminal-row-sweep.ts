// Mirror the window’s stored-row startup reconnect/orphan sweep in main load before main owns layout: retain only rows whose reconnect plan names a terminal.

import { isValidTerminalTabId } from '../terminal-tab-id'
import type { TerminalTab } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { readCanonicalPtyOwners, resolveCanonicalPtyClaim } from './legacy-terminal-row-claims'

/** Apply shutdown-list/fallback-terminal evidence per host partition; each partition lists only its own workspaces. */
export function liveAtShutdown(session: WorkspaceSessionState): (key: string) => boolean {
  const listed = session.activeWorktreeIdsOnShutdown
  return listed
    ? (key) => listed.includes(key)
    : (key) => (session.tabsByWorktree[key] ?? []).some((row) => row.ptyId)
}

type RowSweep = {
  /** Rows outside the tab bar the reconnect plan names no terminal for. */
  unattached: Set<string>
  /** Rows the window's hydration keeps before its sweep; a selection falls back to the first. */
  hydrated: TerminalTab[]
}

function sweepRows(
  session: WorkspaceSessionState,
  key: string,
  rows: readonly TerminalTab[],
  live: boolean
): RowSweep {
  const canonical = readCanonicalPtyOwners(session, key, rows)
  const unattached = new Set<string>()
  const hydrated: TerminalTab[] = []
  for (const row of rows) {
    // Hydration drops these itself; a subsumed row is the Loader's, following to its twin.
    if (!isValidTerminalTabId(row.id)) {
      continue
    }
    const claim = resolveCanonicalPtyClaim(session, row, canonical)
    if (claim.kind === 'subsumed') {
      continue
    }
    hydrated.push(row)
    if (canonical.tabIds.has(row.id)) {
      continue
    }
    // Main cannot know the window’s SSH catalog at load; keep uncertain rows rather than risk losing a terminal.
    const named = [live ? row.ptyId : null, session.remoteSessionIdsByTabId?.[row.id]]
    const reattaches =
      named.some((ptyId) => ptyId && !claim.releasedPtyIds.has(ptyId)) || claim.reconnectPtyId
    if (!reattaches) {
      unattached.add(row.id)
    }
  }
  return { unattached, hydrated }
}

/** Remove startup-orphan rows/layouts and redirect selections like the window sweep; retain resume/close records. */
export function sweepUnattachedTerminalRows(
  session: WorkspaceSessionState,
  live: (key: string) => boolean = liveAtShutdown(session)
): WorkspaceSessionState {
  let next: WorkspaceSessionState | null = null
  for (const [key, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    const { unattached, hydrated } = sweepRows(session, key, rows, live(key))
    if (unattached.size === 0) {
      continue
    }
    next ??= {
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree },
      terminalLayoutsByTabId: { ...session.terminalLayoutsByTabId },
      ...(session.activeTabIdByWorktree
        ? { activeTabIdByWorktree: { ...session.activeTabIdByWorktree } }
        : {})
    }
    next.tabsByWorktree[key] = rows.filter((row) => !unattached.has(row.id))
    for (const tabId of unattached) {
      delete next.terminalLayoutsByTabId[tabId]
    }
    const selected = next.activeTabIdByWorktree?.[key]
    if (next.activeTabIdByWorktree && selected && unattached.has(selected)) {
      const [first] = hydrated
        .filter((row) => !unattached.has(row.id))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
      next.activeTabIdByWorktree[key] = first?.id ?? null
    }
    if (next.activeTabId && unattached.has(next.activeTabId)) {
      next.activeTabId = null
    }
  }
  return next ?? session
}
