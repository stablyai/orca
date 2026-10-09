// Serializer: the layout model and what is kept beside it, written as today's session partition so
// older builds read the same documents. Every redundant field is derived from the one model.

import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import type { BrowserWorkspace } from '../browser-workspace-types'
import type { ClosedTerminalTabTombstonesByTabId } from '../closed-terminal-tab-tombstones'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../tab-types'
import type { TerminalTab } from '../terminal-tab-types'
import type { PersistedOpenFile, WorkspaceSessionState } from '../workspace-session-state-types'
import { pickStoredFields } from './stored-record-fields'
import { pruneGroupLayout } from '../workspace-session-terminal-tab-close'
import {
  BLANK_BROWSER_TAB_STATE,
  CARRIED_SESSION_FIELDS,
  FACT_SESSION_FIELDS,
  VIEW_SESSION_FIELDS
} from './workspace-layout-beside'
import type { LoadedWorkspaceLayout } from './workspace-layout-load-types'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { paneKeyOf, tabsInOrder, type WorkspaceLayout } from './workspace-layout-model'
import { saveTabBarEntry, saveTerminalLayout, saveTerminalRow } from './workspace-layout-save-tabs'

type WorkspaceMaps = {
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId']
  unifiedTabs: Record<string, Tab[]>
  tabGroups: Record<string, TabGroup[]>
  tabGroupLayouts: Record<string, TabGroupLayoutNode>
  openFilesByWorktree: Record<string, PersistedOpenFile[]>
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
}

function saveWorkspace(
  key: string,
  workspace: WorkspaceLayout,
  loaded: LoadedWorkspaceLayout,
  session: WorkspaceMaps
): void {
  const { facts, desktopView: view } = loaded
  const { worktreeId } = workspace
  const scope = {
    workspaceKey: key,
    worktreeId,
    hostId: loaded.layout.hostId,
    editorFiles: workspace.editorFiles,
    leaves: workspace.leaves ?? {},
    facts,
    view
  }
  // Rows and tab-bar entries follow the one tab order, as the rules and older readers expect.
  const ordered = tabsInOrder(workspace)
  const tabs = [...ordered, ...workspace.tabs.filter((tab) => !ordered.includes(tab))]
  const rows = tabs
    .flatMap((tab) => (tab.kind === 'terminal' ? [tab] : []))
    .map((tab, index) => saveTerminalRow(tab, index, scope))
  const placement = new Map<string, { groupId: string; index: number }>()
  for (const group of workspace.groups) {
    group.tabOrder.forEach((tabId, index) => placement.set(tabId, { groupId: group.id, index }))
  }
  const entries: Tab[] = []
  for (const tab of tabs) {
    const place = placement.get(tab.id)
    if (tab.kind === 'terminal') {
      session.terminalLayoutsByTabId[tab.entityId] = saveTerminalLayout(tab, scope)
    }
    if (place) {
      entries.push(saveTabBarEntry(tab, { groupId: place.groupId, sortOrder: place.index }, scope))
    }
  }
  if (rows.length > 0 || loaded.layout.legacy.terminalRowOwners[key]) {
    session.tabsByWorktree[key] = rows
  }
  const groups: TabGroup[] = workspace.groups
    .filter((group) => group.tabOrder.length > 0)
    .map((group) => {
      const selection = view.groups[key]?.[group.id]
      const activeTabId = selection?.activeTabId
      return {
        id: group.id,
        worktreeId,
        activeTabId: activeTabId && group.tabOrder.includes(activeTabId) ? activeTabId : null,
        tabOrder: group.tabOrder,
        ...(selection?.recentTabIds
          ? {
              recentTabIds: selection.recentTabIds.filter((tabId) => group.tabOrder.includes(tabId))
            }
          : {})
      }
    })
  if (groups.length > 0) {
    session.unifiedTabs[key] = entries
    session.tabGroups[key] = groups
    // Today's writer persists only groups holding tabs, and a group tree naming only those.
    const persistedIds = new Set(groups.map((group) => group.id))
    session.tabGroupLayouts[key] = pruneGroupLayout(workspace.groupLayout, persistedIds) ?? {
      type: 'leaf',
      groupId: groups[0]!.id
    }
  }
  if (workspace.editorFiles) {
    // One preview fact per editor tab; today's writer stores the file's copy only when true.
    const previewFiles = new Set(
      workspace.tabs.flatMap((tab) =>
        tab.kind === 'editor' && tab.isPreview ? [tab.entityId] : []
      )
    )
    session.openFilesByWorktree[key] = workspace.editorFiles.map((file): PersistedOpenFile => ({
      ...file,
      worktreeId,
      ...(previewFiles.has(file.filePath) ? { isPreview: true } : {}),
      ...view.editorDrafts[key]?.[file.filePath]
    }))
  }
  if (workspace.browserTabs) {
    session.browserTabsByWorktree[key] = workspace.browserTabs.map((tab): BrowserWorkspace => ({
      ...tab,
      worktreeId,
      ...(facts.browserTabs[key]?.[tab.id] ?? BLANK_BROWSER_TAB_STATE)
    }))
  }
}

/** Records keyed by pane key, each tab and workspace filled from where its pane sits. */
function saveWorkspaceRecords({
  layout,
  carried
}: LoadedWorkspaceLayout): Partial<WorkspaceSessionState> {
  const sleeping: Record<string, SleepingAgentSessionRecord> = {
    ...carried.unplacedSleepingRecords
  }
  const incarnations: Record<string, string> = { ...carried.unplacedIncarnations }
  const closed: ClosedTerminalTabTombstonesByTabId = { ...carried.unplacedClosedTabs }
  for (const { worktreeId, tabs, leaves, closedTerminalTabs } of Object.values(layout.workspaces)) {
    for (const tab of tabs) {
      for (const leafId of tab.kind === 'terminal'
        ? collectLayoutLeafIdsInOrder(tab.panes.root)
        : []) {
        const leaf = leaves?.[leafId]
        const paneKey = paneKeyOf(tab.entityId, leafId)
        if (leaf?.incarnationId !== undefined) {
          incarnations[paneKey] = leaf.incarnationId
        }
        if (leaf?.sleeping) {
          sleeping[paneKey] = { paneKey, tabId: tab.entityId, worktreeId, ...leaf.sleeping }
        }
      }
    }
    for (const [tabId, entry] of Object.entries(closedTerminalTabs ?? {})) {
      closed[tabId] = { ...entry, worktreeId }
    }
  }
  return {
    ...(Object.keys(sleeping).length > 0 ? { sleepingAgentSessionsByPaneKey: sleeping } : {}),
    ...(Object.keys(incarnations).length > 0
      ? { terminalPtyIncarnationsByPaneKey: incarnations }
      : {}),
    ...(Object.keys(closed).length > 0 ? { closedTerminalTabTombstonesByTabId: closed } : {})
  }
}

export function saveWorkspaceLayout(loaded: LoadedWorkspaceLayout): WorkspaceSessionState {
  const { layout, desktopView: view, facts, carried } = loaded
  const { records, legacy } = layout
  const maps: WorkspaceMaps = {
    tabsByWorktree: {},
    terminalLayoutsByTabId: { ...carried.unownedTerminalLayouts },
    unifiedTabs: {},
    tabGroups: {},
    tabGroupLayouts: {},
    openFilesByWorktree: {},
    browserTabsByWorktree: {}
  }
  for (const [key, workspace] of Object.entries(layout.workspaces)) {
    saveWorkspace(key, workspace, loaded, maps)
  }
  return {
    ...pickStoredFields(view, VIEW_SESSION_FIELDS),
    activeRepoId: view.activeRepoId,
    activeWorktreeId: view.activeWorktreeId,
    activeTabId: view.activeTabId,
    ...pickStoredFields(facts, FACT_SESSION_FIELDS),
    ...pickStoredFields(carried, CARRIED_SESSION_FIELDS),
    ...maps,
    ...saveWorkspaceRecords(loaded),
    ...(records.defaultTabsAppliedByWorkspace
      ? { defaultTerminalTabsAppliedByWorktreeId: records.defaultTabsAppliedByWorkspace }
      : {}),
    ...(records.clientHostedBrowserPagesByWorkspace
      ? { clientHostedBrowserPagesByWorktree: records.clientHostedBrowserPagesByWorkspace }
      : {}),
    ...(legacy.topologyRevisionByRepoId
      ? { terminalTopologyRevisionByRepoId: legacy.topologyRevisionByRepoId }
      : {})
  }
}
