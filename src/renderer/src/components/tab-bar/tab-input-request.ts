import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'

type AgentStatusLike = Pick<AgentStatusEntry, 'state' | 'updatedAt'>

// Why: a tab's unread mark records that *something* happened, not *what*. A
// fresh blocked/waiting pane is the agent asking for input — the only case the
// caller surfaces as a bell rather than a green "done" dot.
export function tabHasFreshInputRequest(
  agentStatusByPaneKey: Record<string, AgentStatusLike>,
  tabId: string,
  now: number
): boolean {
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    if (entry.state !== 'blocked' && entry.state !== 'waiting') {
      continue
    }
    const parsed = parsePaneKey(paneKey) ?? parseLegacyNumericPaneKey(paneKey)
    if (parsed?.tabId !== tabId) {
      continue
    }
    if (isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      return true
    }
  }
  return false
}
