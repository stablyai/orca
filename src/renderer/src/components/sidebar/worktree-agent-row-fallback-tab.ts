import { agentEntrySessionStartedAt } from '../../../../shared/agent-session-start-time'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parseAgentStatusPaneIdentity } from '../../../../shared/agent-status-worktree-attribution'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export function effectiveWorktreeAgentRowStartedAt(entry: AgentStatusEntry): number {
  return agentEntrySessionStartedAt(entry)
}

export function tabFromWorktreeAttributedStatusEntry(
  entry: AgentStatusEntry,
  effectiveStartedAt: number,
  representedTab?: Tab
): TerminalTab | null {
  const parsed = parseAgentStatusPaneIdentity(entry.paneKey, representedTab)
  if (!parsed || !entry.worktreeId) {
    return null
  }
  return {
    id: parsed.tabId,
    ptyId: null,
    worktreeId: entry.worktreeId,
    title: entry.terminalTitle ?? 'Agent',
    customTitle: null,
    color: null,
    sortOrder: Number.MAX_SAFE_INTEGER,
    // Missing-tab rows retain their original ordering clock; stateStartedAt changes with status.
    createdAt: effectiveStartedAt
  }
}
