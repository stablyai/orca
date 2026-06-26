import type { AppState } from '@/store/types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

export type WorktreeActivePane = { tabId: string; paneKey: string }

type ResolverState = Pick<
  AppState,
  'groupsByWorktree' | 'activeGroupIdByWorktree' | 'tabsByWorktree' | 'terminalLayoutsByTabId'
>

// Resolves a worktree's currently-focused terminal pane (tab + durable paneKey)
// WITHOUT the active-worktree gate getFocusedAgentPaneKeyForWorktree applies, so a
// backgrounded worktree's terminal can be portaled into a side-by-side column.
// Returns null when the worktree's active tab isn't a terminal.
export function getWorktreeActiveTerminalPane(
  state: ResolverState,
  worktreeId: string
): WorktreeActivePane | null {
  // tabsByWorktree holds the worktree's terminal tabs.
  const terminalTabs = state.tabsByWorktree[worktreeId] ?? []
  if (terminalTabs.length === 0) {
    return null
  }
  // Prefer the active group's active tab when it's a terminal; otherwise fall
  // back to the first terminal tab. Why: this must NOT require the worktree's
  // active tab to currently BE a terminal — a compare column flips the worktree
  // to its diff (editor) when reviewing, and we still need to portal its agent
  // terminal back when switching to Agent. (Otherwise: black screen.)
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const group = groups.find((candidate) => candidate.id === activeGroupId) ?? groups[0]
  const preferredTabId = group?.activeTabId
  const tab = terminalTabs.find((candidate) => candidate.id === preferredTabId) ?? terminalTabs[0]
  const activeLeafId = state.terminalLayoutsByTabId[tab.id]?.activeLeafId
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return null
  }
  return { tabId: tab.id, paneKey: makePaneKey(tab.id, activeLeafId) }
}
