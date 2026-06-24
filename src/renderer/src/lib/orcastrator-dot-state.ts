import type { AgentDotState } from '@/components/AgentStateDot'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { OrchestrationActivity } from '../../../shared/runtime-types'
import { deriveWorktreeAgentDotState } from './worktree-agent-dot-state'

// Why: the freshest in-flight orchestration run among a worktree's tabs, found
// by matching the activity map's coordinator paneKeys (`${tabId}:${leafId}`) to
// the worktree's tab ids. Presence means the director's run is still `running`.
function findOrchestrationActivityForTabs(
  tabIds: readonly string[],
  orchestrationActivityByPaneKey: Record<string, OrchestrationActivity>
): OrchestrationActivity | null {
  for (const [paneKey, activity] of Object.entries(orchestrationActivityByPaneKey)) {
    const colon = paneKey.indexOf(':')
    if (colon <= 0 || !tabIds.includes(paneKey.slice(0, colon))) {
      continue
    }
    return activity
  }
  return null
}

// Why: an Orcastrator is a long-lived supervisor, so a director hook reporting
// `done` means "my turn ended", not "the mission is complete". Mapping that to
// a completion check (as the dashboard's AgentStateDot does) reads as finished
// even while background workers run. This derivation keeps attention/working
// states from the live agent hook, then — when the foreground turn has ended —
// prefers the DB-backed orchestration run signal so a supervising director
// shows a calm pulse and only a truly idle one shows a neutral dot. The check
// glyph is intentionally never produced here.
export function deriveOrcastratorDotState(
  tabIds: readonly string[],
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  orchestrationActivityByPaneKey: Record<string, OrchestrationActivity>
): AgentDotState {
  const base = deriveWorktreeAgentDotState(tabIds, agentStatusByPaneKey)
  // Foreground states win: the director needs the user (blocked/waiting) or is
  // actively producing (working). These take precedence over background runs.
  if (base === 'working' || base === 'blocked' || base === 'waiting') {
    return base
  }
  // Turn has ended (done) or no live agent (idle): fall back to run state so a
  // background-supervising director never collapses to a "finished" indicator.
  const activity = findOrchestrationActivityForTabs(tabIds, orchestrationActivityByPaneKey)
  if (activity) {
    return activity.staleDispatches > 0 ? 'stalled' : 'supervising'
  }
  // No live foreground work and no in-flight run — standing by.
  return 'idle'
}
