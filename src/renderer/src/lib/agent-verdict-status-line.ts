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

/** The line an agent row shows in place of its preview once its verdict marks it. A user's Stop
 *  says so; a turn a newer request replaced reads plainly interrupted, since no one is named; a
 *  turn cut off by a crash reads failed, as a failure does. */
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

// Why programs only: a program's error message is its own one-line account of what failed (e.g.
// "rsync failed"), while an agent's last reply is prose that could be anything.
function failedLine(entry: VerdictLineSource): string {
  if (!isProgramStatusRow(entry)) {
    return 'Failed'
  }
  const message = entry.lastAssistantMessage?.trim() || entry.programStatus?.message
  return message ? `Failed: ${message}` : 'Failed'
}
