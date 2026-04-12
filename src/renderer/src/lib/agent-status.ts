import type { TerminalTab } from '../../../shared/types'

// Re-export from shared module so existing renderer imports continue to work.
// Why: the main process now needs the same agent detection logic for stat
// tracking. Moving to shared avoids duplicating the detection code.
export {
  type AgentStatus,
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  isGeminiTerminalTitle,
  isClaudeAgent
} from '../../../shared/agent-detection'
import { detectAgentStatusFromTitle } from '../../../shared/agent-detection'

type CountWorkingAgentsArgs = {
  tabsByWorktree: Record<string, TerminalTab[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
}

export function countWorkingAgents({
  tabsByWorktree,
  runtimePaneTitlesByTabId
}: CountWorkingAgentsArgs): number {
  let count = 0

  for (const tabs of Object.values(tabsByWorktree)) {
    for (const tab of tabs) {
      count += countWorkingAgentsForTab(tab, runtimePaneTitlesByTabId)
    }
  }

  return count
}

/**
 * Returns a map of worktreeId → number of active agents for that worktree.
 * Only includes worktrees with at least one working agent.
 */
export function countWorkingAgentsPerWorktree({
  tabsByWorktree,
  runtimePaneTitlesByTabId
}: CountWorkingAgentsArgs): Record<string, number> {
  const result: Record<string, number> = {}

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    let count = 0
    for (const tab of tabs) {
      count += countWorkingAgentsForTab(tab, runtimePaneTitlesByTabId)
    }
    if (count > 0) {
      result[worktreeId] = count
    }
  }

  return result
}

function countWorkingAgentsForTab(
  tab: TerminalTab,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
): number {
  let count = 0
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  // Why: split-pane tabs can host multiple concurrent agents, but the
  // legacy tab title only reflects the last pane title update that won the
  // tab label. Prefer pane-level titles whenever TerminalPane is mounted,
  // and fall back to the tab title only for tabs we have not mounted yet
  // (for example restored-but-unvisited worktrees).
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    for (const title of Object.values(paneTitles)) {
      if (detectAgentStatusFromTitle(title) === 'working') {
        count += 1
      }
    }
    return count
  }
  // Why: restored session tabs can keep the last agent title even before a
  // PTY reconnects (or after the PTY is gone). Count only live PTY-backed
  // tab fallbacks so the titlebar matches the sidebar's notion of
  // "actively running" instead of surfacing stale pre-shutdown state.
  if (tab.ptyId && detectAgentStatusFromTitle(tab.title) === 'working') {
    count += 1
  }
  return count
}
