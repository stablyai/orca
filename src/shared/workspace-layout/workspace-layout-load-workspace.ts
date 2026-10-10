import type { Tab } from '../tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { childRecord, pickStoredFields } from './stored-record-fields'
import { resolveGroupOrder, type OrderCandidate } from './workspace-layout-load-order'
import {
  loadBrowserTabs,
  loadEditorFiles,
  resolveWorktreeId
} from './workspace-layout-load-records'
import { loadContentTab, loadTerminalTab } from './workspace-layout-load-tabs'
import type { WorkspaceLoadArgs } from './workspace-layout-load-types'
import type { LayoutTab, LayoutTerminalTab, WorkspaceLayout } from './workspace-layout-model'
import { pruneGroupLayout } from '../workspace-session-terminal-tab-close'

function takeRows({ session, key, terminalHomes }: WorkspaceLoadArgs) {
  const rows: TerminalTab[] = []
  const local = new Set<string>()
  for (const row of session.tabsByWorktree?.[key] ?? []) {
    if (local.has(row.id) || terminalHomes.get(row.id) !== key) {
      continue
    }
    local.add(row.id)
    rows.push(row)
  }
  return rows
}

/** A pane key's leaf for this tab, from the records that name one (the old window's leaf). */
function recordedLeafId(session: WorkspaceSessionState, tabId: string): string | undefined {
  const leafIds = new Set(
    [
      ...Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}),
      ...Object.keys(session.sleepingAgentSessionsByPaneKey ?? {}),
      ...Object.keys(session.terminalSurfaceTombstonesByPaneKey ?? {})
    ].flatMap((paneKey) =>
      paneKey.startsWith(`${tabId}:`) ? [paneKey.slice(tabId.length + 1)] : []
    )
  )
  return leafIds.size === 1 ? [...leafIds][0] : undefined
}

/**
 * A row saved before pane layouts existed becomes a one-pane tab bound to the row's terminal,
 * as today's window restores it; the pane reuses the leaf the records name, else a new one.
 */
function legacyLayout(
  session: WorkspaceSessionState,
  row: TerminalTab,
  args: WorkspaceLoadArgs
): TerminalLayoutSnapshot {
  const leafId = recordedLeafId(session, row.id) ?? args.context.mintLeafId(`leaf:${row.id}`)
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ...(row.ptyId ? { ptyIdsByLeafId: { [leafId]: row.ptyId } } : {})
  }
}

function loadPanes(
  session: WorkspaceSessionState,
  row: TerminalTab,
  tab: Omit<LayoutTerminalTab, 'panes'>,
  args: WorkspaceLoadArgs
): LayoutTerminalTab {
  const layout = session.terminalLayoutsByTabId?.[tab.entityId] ?? legacyLayout(session, row, args)
  // Each pane's data is loaded once every tab is placed (loadLeaves).
  args.layouts.set(tab.entityId, layout)
  return { ...tab, panes: { root: layout.root, ...pickStoredFields(layout, ['chatLeafId']) } }
}

function loadTabs(args: WorkspaceLoadArgs): { tabs: LayoutTab[]; candidates: OrderCandidate[] } {
  const { session, key } = args
  const rows = takeRows(args)
  const rowByEntity = new Map(rows.map((row) => [row.id, row]))
  const merged = new Set<string>()
  const tabs: LayoutTab[] = []
  const candidates: OrderCandidate[] = []
  const tabIds = new Set<string>()
  const addTerminal = (row: TerminalTab, entry: Tab | undefined): void => {
    const tab = loadPanes(session, row, loadTerminalTab(row, entry), args)
    if (tabIds.has(tab.id)) {
      tab.id = args.context.mintId(`tab:${row.id}`)
    }
    merged.add(row.id)
    tabIds.add(tab.id)
    tabs.push(tab)
    // One live title: the tab-bar label when there is one (the row's is often a stale default).
    args.facts.terminalRows[row.id] = {
      title: entry?.label ?? row.title,
      ...pickStoredFields(row, ['generation'])
    }
    candidates.push({
      id: tab.id,
      groupId: entry?.groupId,
      tabBarSortOrder: entry?.sortOrder,
      rowSortOrder: row.sortOrder,
      createdAt: tab.createdAt
    })
  }
  for (const entry of session.unifiedTabs?.[key] ?? []) {
    if (tabIds.has(entry.id)) {
      continue
    }
    if (entry.contentType === 'terminal') {
      const row = rowByEntity.get(entry.entityId)
      if (!row || merged.has(row.id)) {
        continue
      }
      addTerminal(row, entry)
    } else {
      tabs.push(loadContentTab({ ...entry, contentType: entry.contentType }))
      tabIds.add(entry.id)
      candidates.push({
        id: entry.id,
        groupId: entry.groupId,
        tabBarSortOrder: entry.sortOrder,
        createdAt: entry.createdAt
      })
    }
    if (entry.contentType !== 'terminal') {
      childRecord(args.facts.tabLabels, key)[entry.id] = entry.label
    }
    if (entry.lastFocusedAt !== undefined) {
      childRecord(args.view.lastFocusedAt, key)[entry.id] = entry.lastFocusedAt
    }
  }
  for (const row of rows) {
    if (!merged.has(row.id)) {
      addTerminal(row, undefined)
    }
  }
  return { tabs, candidates }
}

export function loadWorkspace(args: WorkspaceLoadArgs): WorkspaceLayout {
  const { session, key, view } = args
  const worktreeId = resolveWorktreeId(args)
  const { tabs, candidates } = loadTabs(args)
  const storedGroups = session.tabGroups?.[key] ?? []
  for (const group of storedGroups) {
    childRecord(view.groups, key)[group.id] ??= {
      activeTabId: group.activeTabId,
      ...pickStoredFields(group, ['recentTabIds'])
    }
  }
  const groups = resolveGroupOrder({
    storedGroups,
    candidates,
    workspaceKey: key,
    mintId: args.context.mintId
  })
  const workspace: WorkspaceLayout = { worktreeId, tabs, groups }
  const groupLayout = pruneGroupLayout(
    session.tabGroupLayouts?.[key],
    new Set(groups.map((group) => group.id))
  )
  if (groupLayout) {
    workspace.groupLayout = groupLayout
  }
  const editorFiles = loadEditorFiles(args, tabs)
  if (editorFiles) {
    workspace.editorFiles = editorFiles
  }
  const browserTabs = loadBrowserTabs(args)
  if (browserTabs) {
    workspace.browserTabs = browserTabs
  }
  return workspace
}
