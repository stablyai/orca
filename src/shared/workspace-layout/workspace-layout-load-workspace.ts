import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'
import type { Tab } from '../tab-types'
import { normalizeTerminalLayoutPtyOwnership } from '../terminal-layout-pty-ownership'
import { sanitizeTerminalLayoutPaneTitles } from '../terminal-pane-title-sanitization'
import type { TerminalLayoutSnapshot, TerminalTab } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { childRecord, pickStoredFields } from './stored-record-fields'
import { readCanonicalPtyOwners, resolveCanonicalPtyClaim } from './legacy-terminal-row-claims'
import { resolveGroupOrder, type OrderCandidate } from './workspace-layout-load-order'
import { resolveTabGroupOwners } from './tab-group-owners'
import {
  loadBrowserTabs,
  loadEditorFiles,
  resolveWorktreeId
} from './workspace-layout-load-records'
import {
  duplicateEditorTabAliases,
  loadContentTab,
  loadTerminalTab
} from './workspace-layout-load-tabs'
import type { WorkspaceLoadArgs } from './workspace-layout-load-types'
import { restoresSavedContentTab } from './saved-editor-tab-restore'
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
  args: WorkspaceLoadArgs,
  entry: Tab | undefined
): LayoutTerminalTab {
  const stored = session.terminalLayoutsByTabId?.[tab.entityId] ?? legacyLayout(session, row, args)
  // Match window restore: one pane per terminal; discard lone-pane titles that repeat the tab name.
  const layout = ORCA_LAYOUT_OWNER_IS_MAIN
    ? sanitizeTerminalLayoutPaneTitles(normalizeTerminalLayoutPtyOwnership(stored).snapshot, {
        ...row,
        // The tab-bar label is live; it also fills a missing quick-command label.
        title: entry?.label ?? row.title,
        quickCommandLabel: row.quickCommandLabel?.trim() || entry?.quickCommandLabel?.trim()
      })
    : stored
  args.layouts.set(tab.entityId, layout)
  return { ...tab, panes: { root: layout.root, ...pickStoredFields(layout, ['chatLeafId']) } }
}

function loadTabs(args: WorkspaceLoadArgs): {
  tabs: LayoutTab[]
  candidates: OrderCandidate[]
  aliases: ReadonlyMap<string, string>
} {
  const { session, key } = args
  const aliases = duplicateEditorTabAliases(session.unifiedTabs?.[key] ?? [])
  const rows = takeRows(args)
  const rowByEntity = new Map(rows.map((row) => [row.id, row]))
  const merged = new Set<string>()
  const savedEditFilePaths = new Set(
    (session.openFilesByWorktree?.[key] ?? []).map((file) => file.filePath)
  )
  // Prune transient tabs only when loading with main’s views; loads without views retain all stored tabs.
  const viewsOf = ORCA_LAYOUT_OWNER_IS_MAIN ? args.context.editorViewsOf : undefined
  const heldViews = viewsOf?.(key) ?? {}
  const viewedEntities = new Set(
    (session.unifiedTabs?.[key] ?? []).flatMap((entry) =>
      heldViews[entry.id] ? [entry.entityId] : []
    )
  )
  const tabs: LayoutTab[] = []
  const candidates: OrderCandidate[] = []
  const tabIds = new Set<string>()
  const addTerminal = (row: TerminalTab, entry: Tab | undefined): void => {
    const tab = loadPanes(session, row, loadTerminalTab(row, entry), args, entry)
    if (tabIds.has(tab.id)) {
      tab.id = args.context.mintId(`tab:${row.id}`)
    }
    merged.add(row.id)
    tabIds.add(tab.id)
    tabs.push(tab)
    // Prefer the live tab-bar label over the row’s often-stale title.
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
    if (tabIds.has(entry.id) || aliases.has(entry.id)) {
      continue
    }
    if (
      viewsOf &&
      entry.contentType !== 'terminal' &&
      !restoresSavedContentTab(entry, savedEditFilePaths, () => viewedEntities.has(entry.entityId))
    ) {
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
  // Match window browser hydration: append orphaned browser records to the retained active group so the window never invents an unknown ID.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const storedGroups = session.tabGroups?.[key] ?? []
    const heldGroupIds = new Set(resolveTabGroupOwners(candidates, storedGroups).values())
    const savedActive = session.activeGroupIdByWorktree?.[key]
    const activeGroupId =
      savedActive && heldGroupIds.has(savedActive)
        ? savedActive
        : storedGroups.find((group) => heldGroupIds.has(group.id))?.id
    for (const record of session.browserTabsByWorktree?.[key] ?? []) {
      if (tabs.some((tab) => tab.kind === 'browser' && tab.entityId === record.id)) {
        continue
      }
      const id = args.context.mintId(`browser-tab:${record.id}`)
      tabs.push({
        id,
        kind: 'browser',
        entityId: record.id,
        createdAt: record.createdAt,
        customTitle: null,
        color: null
      })
      tabIds.add(id)
      childRecord(args.facts.tabLabels, key)[id] = record.title
      candidates.push({
        id,
        groupId: activeGroupId,
        createdAt: record.createdAt
      })
    }
  }
  // A row outside the tab bar whose every terminal a tab-bar tab holds is a stale copy of it.
  const canonical = readCanonicalPtyOwners(session, key, rows)
  for (const row of rows) {
    if (merged.has(row.id)) {
      continue
    }
    const claim = resolveCanonicalPtyClaim(session, row, canonical)
    if (claim.kind === 'subsumed') {
      args.canonicalTabIdBySubsumedTabId.set(row.id, claim.canonicalTabId)
    } else {
      addTerminal(row, undefined)
    }
  }
  return { tabs, candidates, aliases }
}

export function loadWorkspace(args: WorkspaceLoadArgs): WorkspaceLayout {
  const { session, key, view } = args
  const worktreeId = resolveWorktreeId(args)
  const { tabs, candidates, aliases } = loadTabs(args)
  const storedGroups = session.tabGroups?.[key] ?? []
  const kept = (tabId: string): string => aliases.get(tabId) ?? tabId
  for (const group of storedGroups) {
    const recent =
      aliases.size > 0 && group.recentTabIds
        ? { recentTabIds: group.recentTabIds.map(kept) }
        : group
    childRecord(view.groups, key)[group.id] ??= {
      activeTabId: group.activeTabId && kept(group.activeTabId),
      ...pickStoredFields(recent, ['recentTabIds'])
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
  const editorFiles = loadEditorFiles(args, tabs, worktreeId)
  if (editorFiles) {
    workspace.editorFiles = editorFiles
  }
  const browserTabs = loadBrowserTabs(args)
  if (browserTabs) {
    workspace.browserTabs = browserTabs
  }
  const editorViews = loadEditorViews(args, tabs)
  if (editorViews) {
    workspace.editorViews = editorViews
  }
  return workspace
}

function loadEditorViews(
  args: WorkspaceLoadArgs,
  tabs: WorkspaceLayout['tabs']
): WorkspaceLayout['editorViews'] {
  const held = args.context.editorViewsOf?.(args.key)
  if (!held) {
    return undefined
  }
  const views = Object.fromEntries(
    tabs.flatMap((tab) => {
      const view = tab.kind === 'terminal' ? undefined : held[tab.id]
      return view ? [[tab.id, view] as const] : []
    })
  )
  return Object.keys(views).length > 0 ? views : undefined
}
