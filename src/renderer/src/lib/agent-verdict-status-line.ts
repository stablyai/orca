import {
  agentMainAgentVerdict,
  agentVerdictDisplayMark,
  type AgentMainAgentVerdictSource
} from '../../../shared/agent-main-agent-verdict'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { isProgramStatusRow } from './program-status/row'

type VerdictLineSource = AgentMainAgentVerdictSource &
  Partial<
    Pick<AgentStatusEntry, 'lastAssistantMessage' | 'agentType' | 'programStatus' | 'observation'>
  >

/** Replace previews with the verdict: user Stop, interruption by a newer request, or crash failure. */
export function agentVerdictStatusLine(entry: VerdictLineSource): string | null {
  switch (agentVerdictDisplayMark(entry)) {
    case 'failed':
      return failedLine(entry)
    case 'interrupted':
      return agentMainAgentVerdict(entry) === 'cancellation' ? 'Interrupted by user' : 'Interrupted'
    case 'unconfirmed':
      return 'Couldn’t confirm'
    case null:
      return null
  }
}

// Only program errors are reliable one-line failure summaries; agent replies may be unrelated prose.
function failedLine(entry: VerdictLineSource): string {
  if (!isProgramStatusRow(entry)) {
    return 'Failed'
  }
  const message = entry.lastAssistantMessage?.trim() || entry.programStatus?.message
  return message ? `Failed: ${message}` : 'Failed'
}
