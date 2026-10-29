import { SessionUnitIndex } from '../session-unit-index'
import { SessionUnitReader, readSessionUnit } from '../session-unit-reader'
// Persist touched legacy duplicates in their loaded form; otherwise closing/moving the canonical claimant can resurrect stale stored rows on the next load.

import type { TerminalTab } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import {
  readCanonicalPtyOwners,
  readPersistedTerminalPtyIds,
  resolveCanonicalPtyClaim
} from './legacy-terminal-row-claims'
import { stableJson } from './workspace-layout-load-report'

/** Replace folded rows when their own/claimant ownership changes: retain loaded layouts/rows or deletion, redirecting removed selections to the canonical twin. */
export function adoptTouchedFoldedRows(
  stored: WorkspaceSessionState,
  patched: WorkspaceSessionState,
  loaded: WorkspaceSessionState
): WorkspaceSessionState {
  const reader = SessionUnitReader.between(stored, patched, new SessionUnitIndex(stored))
  return reduceTouchedFoldedRows(reader, loaded, Object.keys(stored.tabsByWorktree ?? {}))
    ? reader.snapshot()
    : stored
}

export function reduceTouchedFoldedRows(
  reader: SessionUnitReader,
  loaded: WorkspaceSessionState,
  owners: Iterable<string>
): boolean {
  let changed = false
  for (const key of owners) {
    const rows = reader.unit('tabsByWorktree', key, 'prior').value ?? []
    const prior = reader.prior
    const canonical = readCanonicalPtyOwners(prior, key, rows)
    for (const row of rows) {
      if (canonical.tabIds.has(row.id)) {
        continue
      }
      const claim = resolveCanonicalPtyClaim(prior, row, canonical)
      if (claim.kind === 'retained' && claim.releasedPtyIds.size === 0) {
        continue
      }
      const claimants = ptyIdsOf(prior, row).flatMap((pty) => canonical.tabIdByPtyId.get(pty) ?? [])
      if (
        ![row.id, ...claimants].some((id) => claimOf(prior, key, id) !== claimOf(reader, key, id))
      ) {
        continue
      }
      changed = true
      const loadedRow = loaded.tabsByWorktree?.[key]?.find((candidate) => candidate.id === row.id)
      const current = reader.unit('tabsByWorktree', key).value ?? []
      reader.write('tabsByWorktree', key, {
        present: true,
        value: current.flatMap((candidate) =>
          candidate.id !== row.id ? [candidate] : loadedRow ? [loadedRow] : []
        )
      })
      const layout = loaded.terminalLayoutsByTabId?.[row.id]
      reader.write(
        'terminalLayoutsByTabId',
        row.id,
        layout ? { present: true, value: layout } : { present: false, value: undefined }
      )
      if (!loadedRow && reader.field('activeTabId').value === row.id) {
        reader.replace('activeTabId', { present: true, value: loaded.activeTabId })
      }
      if (!loadedRow && reader.unit('activeTabIdByWorktree', key).value === row.id) {
        reader.write('activeTabIdByWorktree', key, {
          present: true,
          value: loaded.activeTabIdByWorktree?.[key] ?? null
        })
      }
    }
  }
  return changed
}

function ptyIdsOf(session: WorkspaceSessionState | SessionUnitReader, row: TerminalTab): string[] {
  const { owned, orphaned } = readPersistedTerminalPtyIds(session, row)
  return [...owned, ...orphaned]
}

function claimOf(
  session: WorkspaceSessionState | SessionUnitReader,
  key: string,
  tabId: string
): string {
  const row = readSessionUnit(session, 'tabsByWorktree', key)?.find(
    (candidate) => candidate.id === tabId
  )
  const entry = readSessionUnit(session, 'unifiedTabs', key)?.some(
    (candidate) => candidate.entityId === tabId
  )
  return stableJson({ row: Boolean(row), entry, ptyIds: row ? ptyIdsOf(session, row).sort() : [] })
}
