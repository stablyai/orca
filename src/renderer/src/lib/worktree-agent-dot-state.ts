import type { AgentDotState } from '@/components/AgentStateDot'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'

// Why: a worktree's live agent is the freshest agent-status entry among its tabs
// (paneKey is `${tabId}:${leafId}`). Shared so the dot and the per-row activity
// line derive from one rule, not several copies that could drift apart.
export function selectFreshestWorktreeAgentEntry(
  tabIds: readonly string[],
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): AgentStatusEntry | null {
  let latest: AgentStatusEntry | null = null
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const colon = paneKey.indexOf(':')
    if (colon <= 0 || !tabIds.includes(paneKey.slice(0, colon))) {
      continue
    }
    if (!latest || entry.stateStartedAt > latest.stateStartedAt) {
      latest = entry
    }
  }
  return latest
}

// Why: shared so the Orcastrators sidebar and Mission Control render identical
// dots from one rule, not two copies.
export function deriveWorktreeAgentDotState(
  tabIds: readonly string[],
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): AgentDotState {
  return selectFreshestWorktreeAgentEntry(tabIds, agentStatusByPaneKey)?.state ?? 'idle'
}
