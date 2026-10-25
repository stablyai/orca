// The model as today's `session.tabs.*` snapshot (design 2.6), for old phones and desktops. Rows,
// ids and group orders keep today's shape (wire rule 3). The runtime still adds what the model
// does not hold: live terminal handles, agent status, terminal theme, launch drafts, a browser
// page's certificate failure, a dirty markdown draft's document version, and the publication
// epoch and version.

import { defaultAgentChatLabel } from '../../agent-session/agent-session-chat-label'
import { resolveTerminalTabTitle } from '../../tab-title-resolution'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../runtime-session-contracts'
import type { TerminalLayoutSnapshot } from '../../terminal-tab-types'
import { pruneGroupLayout } from '../../workspace-session-terminal-tab-close'
import { diffTabRow, editorTabRow, reviewTabRow } from './old-client-session-editor-rows'
import { agentSessionRowId, publishedTabOrderId, terminalRowId } from './old-client-session-row-ids'
import { collectLayoutLeafIdsInOrder } from '../terminal-pane-tree'
import { groupsInLayoutOrder } from './old-client-group-order'
import {
  BLANK_BROWSER_TAB_STATE,
  type DesktopLayoutView,
  type LayoutContentFacts
} from '../workspace-layout-beside'
import type {
  LayoutContentTab,
  LayoutTab,
  LayoutTerminalTab,
  WorkspaceLayout
} from '../workspace-layout-model'

/** One view's selection: the desktop's record today, a phone's own record once views exist. */
export type SessionTabsView = Pick<
  DesktopLayoutView,
  'activeGroupIdByWorktree' | 'groups' | 'panes' | 'editorDrafts'
>

export type SessionTabsFacts = Pick<
  LayoutContentFacts,
  'tabLabels' | 'terminalRows' | 'browserTabs'
>

/** The snapshot minus what only the runtime stamps: publication epoch, version and fences. */
export type ProjectedSessionTabs = Omit<
  RuntimeMobileSessionTabsSnapshot,
  'publicationEpoch' | 'snapshotVersion' | 'worktreeInstanceId' | 'retiredTerminalSurfaces'
>

type Scope = {
  key: string
  workspace: WorkspaceLayout
  view: SessionTabsView
  facts: SessionTabsFacts
  /** The tab shown in the view's active group; its rows are the active ones. */
  activeTabId: string | null
  /** The user's generated-titles setting, which today's title order reads. */
  generatedTitlesEnabled: boolean
}

export function projectSessionTabs(
  key: string,
  workspace: WorkspaceLayout,
  view: SessionTabsView,
  facts: SessionTabsFacts,
  generatedTitlesEnabled: boolean
): ProjectedSessionTabs {
  const activeGroupId = resolveActiveGroupId(workspace, view.activeGroupIdByWorktree?.[key])
  const groupViews = view.groups[key] ?? {}
  const scope: Scope = {
    key,
    workspace,
    view,
    facts,
    generatedTitlesEnabled,
    activeTabId: activeGroupId ? (groupViews[activeGroupId]?.activeTabId ?? null) : null
  }
  const byId = new Map(workspace.tabs.map((tab) => [tab.id, tab]))
  const tabs: RuntimeMobileSessionSnapshotTab[] = []
  const tabGroups: RuntimeMobileSessionTabGroup[] = []
  for (const group of groupsInLayoutOrder(workspace)) {
    const tabOrder: string[] = []
    for (const tabId of group.tabOrder) {
      const tab = byId.get(tabId)
      const rows = tab ? projectTab(tab, scope) : []
      if (tab && rows.length > 0) {
        tabs.push(...rows)
        tabOrder.push(publishedTabOrderId(tab))
      }
    }
    if (tabOrder.length === 0) {
      continue
    }
    const shown = new Set(tabOrder)
    const groupView = groupViews[group.id]
    const activeTab = groupView?.activeTabId ? byId.get(groupView.activeTabId) : undefined
    const activeId = activeTab ? publishedTabOrderId(activeTab) : null
    tabGroups.push({
      id: group.id,
      activeTabId: activeId && shown.has(activeId) ? activeId : null,
      tabOrder,
      recentTabIds: (groupView?.recentTabIds ?? []).flatMap((id) => {
        const recent = byId.get(id)
        const published = recent ? publishedTabOrderId(recent) : null
        return published && shown.has(published) ? [published] : []
      })
    })
  }
  const active = tabs.find((tab) => tab.isActive) ?? null
  const tabGroupLayout =
    tabGroups.length > 0
      ? pruneGroupLayout(workspace.groupLayout, new Set(tabGroups.map((group) => group.id)))
      : undefined
  return {
    worktree: key,
    activeGroupId,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...(tabGroups.length > 0 ? { tabGroups } : {}),
    ...(tabGroupLayout ? { tabGroupLayout } : {}),
    tabs
  }
}

/** As a window restores it: the saved group while the workspace has it, else the first group. */
function resolveActiveGroupId(
  workspace: WorkspaceLayout,
  saved: string | undefined
): string | null {
  if (saved && workspace.groups.some((group) => group.id === saved)) {
    return saved
  }
  return groupsInLayoutOrder(workspace)[0]?.id ?? null
}

function projectTab(tab: LayoutTab, scope: Scope): RuntimeMobileSessionSnapshotTab[] {
  switch (tab.kind) {
    case 'terminal':
      return terminalRows(tab, scope)
    case 'editor': {
      const row = editorTabRow(tab, scope)
      return row ? [row] : []
    }
    case 'diff': {
      const row = diffTabRow(tab, scope)
      return row ? [row] : []
    }
    case 'browser': {
      const row = browserRow(tab, scope)
      return row ? [row] : []
    }
    case 'agent-session': {
      const row = agentSessionRow(tab, scope)
      return row ? [row] : []
    }
    case 'conflict-review':
    case 'check-details': {
      const row = reviewTabRow({ ...tab, kind: tab.kind }, scope)
      return row ? [row] : []
    }
    // A simulator needs the desktop to draw it; the window lists none either.
    case 'simulator':
      return []
  }
}

const tabProps = (tab: LayoutTab) => ({
  ...(tab.color != null ? { color: tab.color } : {}),
  ...(tab.isPinned ? { isPinned: true } : {})
})

function terminalRows(tab: LayoutTerminalTab, scope: Scope): RuntimeMobileSessionTerminalTab[] {
  const leafIds = collectLayoutLeafIdsInOrder(tab.panes.root)
  const leaves = scope.workspace.leaves ?? {}
  const paneView = scope.view.panes[tab.entityId]
  const activeLeafId = paneView?.activeLeafId ?? leafIds[0] ?? null
  const ptyIdsByLeafId = recordOf(leafIds, (leafId) => leaves[leafId]?.ptyId)
  const titlesByLeafId = recordOf(leafIds, (leafId) => leaves[leafId]?.title)
  const parentLayout: TerminalLayoutSnapshot = {
    root: tab.panes.root,
    activeLeafId,
    expandedLeafId: paneView?.expandedLeafId ?? null,
    ...(tab.panes.chatLeafId ? { chatLeafId: tab.panes.chatLeafId } : {}),
    ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
    ...(titlesByLeafId ? { titlesByLeafId } : {})
  }
  // Tab-wide evidence (tab title, quick-command label, launch agent) describes a sole pane that is
  // also the focused one, as the window publishes it.
  const root = tab.panes.root
  const tabWide = root?.type === 'leaf' && activeLeafId === root.leafId
  const liveTitle =
    scope.facts.terminalRows[tab.entityId]?.title ?? tab.terminal.defaultTitle ?? 'Terminal'
  return leafIds.map((leafId) => {
    const leaf = leaves[leafId]
    const paneTitle = leaf?.title?.trim() || undefined
    // Today's order: a custom title beats the pane's own title (#19582); other panes show theirs.
    const title = tabWide
      ? resolveTerminalTabTitle(
          { ...tab, title: paneTitle ?? liveTitle },
          scope.generatedTitlesEnabled,
          paneTitle ?? liveTitle
        )
      : (paneTitle ?? 'Terminal')
    return {
      type: 'terminal',
      id: terminalRowId(tab.entityId, leafId),
      title,
      // A paired desktop reads an absent name as "keep mine", so a cleared name is sent as null.
      customTitle: tab.customTitle?.trim() || null,
      ...(tabWide && tab.quickCommandLabel?.trim()
        ? { quickCommandLabel: tab.quickCommandLabel.trim() }
        : {}),
      ...(tabWide && tab.aiVaultTitle?.title.trim() ? { aiVaultTitle: tab.aiVaultTitle } : {}),
      ...(tabWide && scope.generatedTitlesEnabled && tab.generatedTitle?.trim()
        ? { generatedTitle: tab.generatedTitle.trim() }
        : {}),
      parentTabId: tab.entityId,
      leafId,
      ...(leaf?.ptyId ? { ptyId: leaf.ptyId } : {}),
      ...(leaf?.incarnationId ? { incarnationId: leaf.incarnationId } : {}),
      ...(tabWide && tab.terminal.launchAgent ? { launchAgent: tab.terminal.launchAgent } : {}),
      ...(tab.terminal.startupCwd ? { startupCwd: tab.terminal.startupCwd } : {}),
      parentLayout,
      ...tabProps(tab),
      ...(tab.viewMode ? { viewMode: tab.viewMode } : {}),
      isActive: scope.activeTabId === tab.id && leafId === activeLeafId
    }
  })
}

function recordOf(
  keys: string[],
  read: (key: string) => string | undefined
): Record<string, string> | undefined {
  const entries = keys.flatMap((key) => {
    const value = read(key)
    return value ? [[key, value] as const] : []
  })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function browserRow(tab: LayoutContentTab, scope: Scope): RuntimeMobileSessionBrowserTab | null {
  const record = scope.workspace.browserTabs?.find((entry) => entry.id === tab.entityId)
  const live = scope.facts.browserTabs[scope.key]?.[tab.entityId] ?? BLANK_BROWSER_TAB_STATE
  // A workspace document is served to one desktop only; old clients would offer it as a web page.
  if (live.docLocation) {
    return null
  }
  return {
    type: 'browser',
    id: tab.id,
    title: live.title || live.url || 'Browser',
    browserWorkspaceId: tab.entityId,
    browserPageId: live.activePageId ?? record?.pageIds?.[0] ?? null,
    url: live.url || 'about:blank',
    loading: live.loading,
    canGoBack: live.canGoBack,
    canGoForward: live.canGoForward,
    loadError: live.loadError,
    color: tab.color ?? null,
    isPinned: tab.isPinned === true,
    isActive: scope.activeTabId === tab.id
  }
}

/** The row names its agent; a chat tab whose agent is unknown has nothing to open. */
function agentSessionRow(tab: LayoutContentTab, scope: Scope): RuntimeMobileSessionAgentTab | null {
  const agent = tab.agentSessionAgent
  if (!agent) {
    return null
  }
  return {
    type: 'agent-session',
    id: agentSessionRowId(tab.entityId),
    title:
      tab.customTitle?.trim() ||
      scope.facts.tabLabels[scope.key]?.[tab.id] ||
      defaultAgentChatLabel(agent),
    sessionId: tab.entityId,
    agent,
    ...tabProps(tab),
    isActive: scope.activeTabId === tab.id
  }
}
