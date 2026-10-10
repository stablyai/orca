// The shadow self-check. Its assertion is idempotence: what today's writers store must load and
// save to a fixed point, so a second load changes nothing. A first load may change what older
// writers left (the Loader's fixed precedence); the known-kinds list below is broad, so it only
// catches a field no rule touches. The first load's change counts per kind are returned for
// logging, so a new kind of change shows up even when it is in the list.

import type { ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { stableJson } from './workspace-layout-load-report'
import { saveWorkspaceLayout } from './workspace-layout-save'

const ORDER = ['sortOrder', '$order']
const TAB_FACTS = [
  'createdAt',
  'color',
  'aiVaultTitle',
  'quickCommandLabel',
  'isPinned',
  'viewMode',
  'worktreeId'
]

/**
 * Each `table.field` a Loader rule can change, by rule: one tab order; rows get a tab-bar entry
 * and group, and repeated or orphaned records go (`*`); the row wins over its tab-bar entry, the
 * label over the row title, the owner over a stored host, the focused pane over the row's
 * terminal, and permanent over a disagreeing preview flag; repeated pane ids get new ids, a
 * terminal in two panes stays in the first, and legacy tombstones and pane-less rows are applied.
 */
export const KNOWN_LOAD_CHANGES: ReadonlySet<string> = new Set([
  ...['row', 'terminalEntry', 'entry', 'group', 'layout', 'sleeping', 'incarnation', 'file'].map(
    (table) => `${table}.*`
  ),
  ...['row', 'terminalEntry', 'entry', 'group'].flatMap((table) =>
    ORDER.map((field) => `${table}.${field}`)
  ),
  'group.tabOrder',
  'group.worktreeId',
  'group.activeTabId',
  'group.recentTabIds',
  'row.title',
  'row.ptyId',
  // Transient handoffs older builds' minimal row mint stored; never restored.
  'row.pendingActivationSpawn',
  'row.recovery',
  'row.customTitle',
  'row.generatedTitle',
  ...TAB_FACTS.flatMap((field) => [`row.${field}`, `terminalEntry.${field}`, `entry.${field}`]),
  'terminalEntry.label',
  'terminalEntry.customLabel',
  'terminalEntry.generatedLabel',
  'terminalEntry.executionHostId',
  'terminalEntry.groupId',
  'entry.executionHostId',
  'entry.groupId',
  'entry.isPreview',
  'file.isPreview',
  'file.worktreeId',
  'browser.worktreeId',
  'sleeping.worktreeId',
  'closedTab.worktreeId',
  ...[
    'root',
    'activeLeafId',
    'expandedLeafId',
    'chatLeafId',
    'ptyIdsByLeafId',
    'titlesByLeafId',
    'buffersByLeafId',
    'scrollbackRefsByLeafId'
  ].map((field) => `layout.${field}`),
  ...[
    'unifiedTabs',
    'tabGroups',
    'tabGroupLayouts',
    'tabsByWorktree',
    'terminalSurfaceTombstonesByPaneKey',
    'terminalTopologyRevisionByRepoId',
    'terminalPtyIncarnationsByPaneKey',
    'sleepingAgentSessionsByPaneKey'
  ].map((field) => `session.${field}`)
])

export type LayoutRoundTripFinding =
  /** A first-load change no Loader rule produces. */
  | { kind: 'unknown_change'; change: string }
  /** Loading what was just saved changed it again. */
  | { kind: 'not_idempotent'; change: string }
  | { kind: 'threw'; message: string }

const kinds = (changes: readonly { table: string; field: string }[]) => [
  ...new Set(changes.map((change) => `${change.table}.${change.field}`))
]

export type LayoutRoundTripResult = {
  findings: LayoutRoundTripFinding[]
  /** `table.field` → how many values the first load changed. */
  firstLoadChanges: Record<string, number>
}

/** Loader then Serializer, twice: names and kinds only, never values. */
export function checkLayoutRoundTrip(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): LayoutRoundTripResult {
  const firstLoadChanges: Record<string, number> = {}
  try {
    const first = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
    for (const change of first.changes) {
      const kind = `${change.table}.${change.field}`
      firstLoadChanges[kind] = (firstLoadChanges[kind] ?? 0) + 1
    }
    const findings: LayoutRoundTripFinding[] = kinds(first.changes)
      .filter((change) => !KNOWN_LOAD_CHANGES.has(change))
      .map((change) => ({ kind: 'unknown_change', change }))
    const saved = saveWorkspaceLayout(first)
    const second = loadWorkspaceLayout(hostId, saved, nameBasedLoadContext())
    findings.push(
      ...kinds(second.changes).map((change): LayoutRoundTripFinding => ({
        kind: 'not_idempotent',
        change
      }))
    )
    if (
      second.changes.length === 0 &&
      stableJson(saveWorkspaceLayout(second)) !== stableJson(saved)
    ) {
      findings.push({ kind: 'not_idempotent', change: 'saved document' })
    }
    return { findings, firstLoadChanges }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { findings: [{ kind: 'threw', message }], firstLoadChanges }
  }
}
