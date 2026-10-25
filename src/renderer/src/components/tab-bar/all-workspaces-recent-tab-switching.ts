// Builds the Ctrl+Tab list for the all-workspaces scope, in the order the Tab Order setting picks:
// by last focus like Cmd+J's recent tabs, or by place on screen like the tab strip.

import type {
  CtrlTabOrderMode,
  TabContentType,
  WorkspaceVisibleTabType
} from '../../../../shared/tab-types'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import { orderRecentWorkspaceTabs } from '@/lib/recent-workspace-tab-rows'
import type { AppState } from '@/store/types'
import type { VisibleWorktreeShortcutTarget } from '../sidebar/visible-worktrees'
import { collectAllWorkspacesRecentTabCandidates } from './all-workspaces-recent-tab-candidates'
import { compareTabStripPositions } from './all-workspaces-tab-strip-position'
import type { OpenTabSearchResult } from './open-tab-search'
import type { AgentSessionTabSwitchResult } from './open-tab-selection-routing'

export type AllWorkspacesRecentTabItem = {
  key: string
  label: string
  /** Project and workspace that own the tab. */
  location: string
  type: WorkspaceVisibleTabType
  contentType: TabContentType
  isDirty: boolean
  /** The chat's provider, or the agent that runs in a terminal; drives the row icon. */
  agent: TerminalAgent | null
  result: OpenTabSearchResult | AgentSessionTabSwitchResult
}

export type AllWorkspacesRecentTabSwitcherModel = {
  items: AllWorkspacesRecentTabItem[]
  activeIndex: number
}

export type AllWorkspacesRecentTabState = Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'agentStatusByPaneKey'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'folderWorkspaces'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'openFiles'
  | 'paneForegroundAgentByPaneKey'
  | 'repos'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
> & { settings?: AppState['settings'] }

export function buildAllWorkspacesRecentTabSwitcherModel(
  state: AllWorkspacesRecentTabState,
  order: { mode: CtrlTabOrderMode; sidebarOrder: readonly VisibleWorktreeShortcutTarget[] }
): AllWorkspacesRecentTabSwitcherModel | null {
  const candidates = collectAllWorkspacesRecentTabCandidates(state, order.sidebarOrder)
  if (candidates.length === 0) {
    return null
  }
  if (order.mode === 'sequential') {
    // Why: as in This workspace, the tab on screen keeps its place and Tab moves to the next one.
    const ordered = [...candidates].sort((a, b) => compareTabStripPositions(a.position, b.position))
    return {
      items: ordered.map((candidate) => candidate.item),
      activeIndex: ordered.findIndex((candidate) => candidate.isCurrent)
    }
  }
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.item.key, candidate]))
  const ordered = orderRecentWorkspaceTabs({
    rows: candidates.map((candidate) => ({
      id: candidate.item.key,
      lastFocusedAt: candidate.lastFocusedAt
    }))
  }).flatMap((key) => candidateByKey.get(key) ?? [])
  const currentIndex = ordered.findIndex((candidate) => candidate.isCurrent)
  if (currentIndex > 0) {
    // Why: the tab on screen leads so the first Tab press lands on the previous one.
    const [current] = ordered.splice(currentIndex, 1)
    ordered.unshift(current)
  }
  return {
    items: ordered.map((candidate) => candidate.item),
    activeIndex: currentIndex === -1 ? -1 : 0
  }
}
