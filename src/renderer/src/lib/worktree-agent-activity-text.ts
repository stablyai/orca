import { agentStateLabel } from '@/components/AgentStateDot'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { selectFreshestWorktreeAgentEntry } from '@/lib/worktree-agent-dot-state'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'

// Why: the lineage "Spawned work" rows show the same live activity line
// DashboardAgentRow derives — the freshest agent's orchestration label/prompt —
// so the text and its live updates match the rest of the app. Falls back to the
// state label when an agent is live but reported no prompt (mirrors
// DashboardAgentRow's empty case); null when no agent has reported for the
// worktree, so the row omits the line instead of showing a placeholder.
export function selectWorktreeAgentActivityText(
  tabIds: readonly string[],
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): string | null {
  const entry = selectFreshestWorktreeAgentEntry(tabIds, agentStatusByPaneKey)
  if (!entry) {
    return null
  }
  return getAgentRowPrimaryText(entry) || agentStateLabel(entry.state)
}
