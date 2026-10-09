// The shadow self-check: what today's writers store must load and save to a fixed point. A first
// load may change what older writers left (the Loader's fixed precedence), but only in the kinds
// of change those rules produce; a second load must change nothing.

import type { ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { stableJson } from './workspace-layout-load-report'
import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'
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
  // Transient handoffs main's minimal row mint stores; never restored.
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

/** Ids the Loader mints are numbered in load order, so reloading the same data mints the same ids. */
export function deterministicLoadContext(): WorkspaceLayoutLoadContext {
  let next = 0
  const mint = () => ++next
  return {
    mintId: () => `layout-minted-${mint()}`,
    mintLeafId: () => `00000000-0000-4000-8000-${String(mint()).padStart(12, '0')}`
  }
}

const kinds = (changes: readonly { table: string; field: string }[]) => [
  ...new Set(changes.map((change) => `${change.table}.${change.field}`))
]

/** Loader then Serializer, twice: names and kinds only, never values. */
export function checkLayoutRoundTrip(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): LayoutRoundTripFinding[] {
  try {
    const first = loadWorkspaceLayout(hostId, session, deterministicLoadContext())
    const findings: LayoutRoundTripFinding[] = kinds(first.changes)
      .filter((change) => !KNOWN_LOAD_CHANGES.has(change))
      .map((change) => ({ kind: 'unknown_change', change }))
    const saved = saveWorkspaceLayout(first)
    const second = loadWorkspaceLayout(hostId, saved, deterministicLoadContext())
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
    return findings
  } catch (error) {
    return [{ kind: 'threw', message: error instanceof Error ? error.message : String(error) }]
  }
}
