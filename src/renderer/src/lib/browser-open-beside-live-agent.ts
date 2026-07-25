import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

const LIVE_AGENT_STATES = new Set<AgentStatusState>(['working', 'blocked', 'waiting'])

export type BrowserOpenBesideLiveAgentState = {
  activeWorktreeId: string | null
  activeTabType: string | null
  agentStatusByPaneKey?: Record<string, AgentStatusEntry> | null
  tabsByWorktree?: Record<string, readonly { id: string }[]>
}

/**
 * True when activating a browser tab in `worktreeId` would replace a live agent
 * terminal the user is currently watching. Callers should open the browser in a
 * side split instead of swapping the group active tab.
 */
export function shouldOpenBrowserBesideLiveAgent(
  state: BrowserOpenBesideLiveAgentState,
  worktreeId: string
): boolean {
  if (state.activeWorktreeId !== worktreeId) {
    return false
  }
  // Why: only the terminal surface is the live agent conversation; editor/browser
  // already replaced it, so a normal browser activate is fine.
  if (state.activeTabType !== 'terminal') {
    return false
  }

  const statuses = state.agentStatusByPaneKey
  if (!statuses) {
    return false
  }

  const terminalIds = new Set((state.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id))
  if (terminalIds.size === 0) {
    return false
  }

  for (const entry of Object.values(statuses)) {
    if (!LIVE_AGENT_STATES.has(entry.state)) {
      continue
    }
    if (entry.worktreeId && entry.worktreeId !== worktreeId) {
      continue
    }
    const tabId = entry.tabId ?? parsePaneKey(entry.paneKey)?.tabId
    if (tabId && terminalIds.has(tabId)) {
      return true
    }
    // Why: some rows only carry worktreeId before tab attribution hydrates —
    // still treat a live row on this worktree as a surface to preserve.
    if (!tabId && entry.worktreeId === worktreeId) {
      return true
    }
  }

  return false
}
