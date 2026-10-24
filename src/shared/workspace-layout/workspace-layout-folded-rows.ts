// Legacy terminal rows the load folds into a tab-bar tab: dropped as a stale copy of it, or with
// its terminal taken off them (legacy-terminal-row-claims). Stored, they still name that terminal,
// so once a command closes the claiming tab, moves its terminal, or gives the row a tab-bar entry,
// the next load resolves the claim another way and the row comes back. Such a command writes the
// row in the load's form.

import type { TerminalTab } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import {
  readCanonicalPtyOwners,
  readPersistedTerminalPtyIds,
  resolveCanonicalPtyClaim
} from './legacy-terminal-row-claims'
import { stableJson } from './workspace-layout-load-report'

/**
 * `stored` with each folded row whose claim `patched` changes (its own, or a claiming tab's)
 * replaced by its form in `loaded`: gone when the load dropped it, with a selection naming it
 * following its twin as the load does; its row and pane layout as loaded otherwise.
 */
export function adoptTouchedFoldedRows(
  stored: WorkspaceSessionState,
  patched: WorkspaceSessionState,
  loaded: WorkspaceSessionState
): WorkspaceSessionState {
  let adopted = stored
  for (const [key, rows] of Object.entries(stored.tabsByWorktree ?? {})) {
    const canonical = readCanonicalPtyOwners(stored, key, rows)
    for (const row of rows) {
      if (canonical.tabIds.has(row.id)) {
        continue
      }
      const claim = resolveCanonicalPtyClaim(stored, row, canonical)
      if (claim.kind === 'retained' && claim.releasedPtyIds.size === 0) {
        continue
      }
      const claimants = ptyIdsOf(stored, row).flatMap(
        (ptyId) => canonical.tabIdByPtyId.get(ptyId) ?? []
      )
      const touched = [row.id, ...claimants].some(
        (tabId) => claimOf(stored, key, tabId) !== claimOf(patched, key, tabId)
      )
      if (touched) {
        adopted = withLoadedRow(adopted, loaded, key, row.id)
      }
    }
  }
  return adopted
}

/** The terminals a row names, as the claim rule reads them (the row's own and its panes'). */
function ptyIdsOf(session: WorkspaceSessionState, row: TerminalTab): string[] {
  const { owned, orphaned } = readPersistedTerminalPtyIds(session, row)
  return [...owned, ...orphaned]
}

/** What a tab claims with: whether it has a row and a tab-bar entry, and the terminals it names. */
function claimOf(session: WorkspaceSessionState, key: string, tabId: string): string {
  const row = session.tabsByWorktree?.[key]?.find((candidate) => candidate.id === tabId)
  const entry = session.unifiedTabs?.[key]?.some((candidate) => candidate.entityId === tabId)
  return stableJson({ row: Boolean(row), entry, ptyIds: row ? ptyIdsOf(session, row).sort() : [] })
}

function withLoadedRow(
  session: WorkspaceSessionState,
  loaded: WorkspaceSessionState,
  key: string,
  tabId: string
): WorkspaceSessionState {
  const loadedRow = loaded.tabsByWorktree?.[key]?.find((row) => row.id === tabId)
  const rows = (session.tabsByWorktree[key] ?? []).flatMap((row) =>
    row.id !== tabId ? [row] : loadedRow ? [loadedRow] : []
  )
  const next: WorkspaceSessionState = {
    ...session,
    tabsByWorktree: { ...session.tabsByWorktree, [key]: rows },
    ...withLoadedLayout(session, loaded, tabId)
  }
  if (!loadedRow && next.activeTabId === tabId) {
    next.activeTabId = loaded.activeTabId
  }
  if (!loadedRow && next.activeTabIdByWorktree?.[key] === tabId) {
    next.activeTabIdByWorktree = {
      ...next.activeTabIdByWorktree,
      [key]: loaded.activeTabIdByWorktree?.[key] ?? null
    }
  }
  return next
}

/** The pane layouts with the tab's as loaded; nothing when neither side has one. */
function withLoadedLayout(
  session: WorkspaceSessionState,
  loaded: WorkspaceSessionState,
  tabId: string
): Pick<WorkspaceSessionState, 'terminalLayoutsByTabId'> | Record<string, never> {
  const { [tabId]: stored, ...rest } = session.terminalLayoutsByTabId ?? {}
  const layout = loaded.terminalLayoutsByTabId?.[tabId]
  if (!stored && !layout) {
    return {}
  }
  return { terminalLayoutsByTabId: layout ? { ...rest, [tabId]: layout } : rest }
}
