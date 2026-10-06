import {
  agentMainAgentVerdict,
  agentVerdictDisplayMark,
  type AgentMainAgentVerdictSource
} from '../../../shared/agent-main-agent-verdict'

/** The line an agent row shows in place of its preview once its verdict marks it. A user's Stop
 *  says so; a turn a newer request replaced reads plainly interrupted, since no one is named; a
 *  turn cut off by a crash reads failed, as a failure does. */
export function agentVerdictStatusLine(entry: AgentMainAgentVerdictSource): string | null {
  switch (agentVerdictDisplayMark(entry)) {
    case 'failed':
      return 'Failed'
    case 'interrupted':
      return agentMainAgentVerdict(entry) === 'cancellation' ? 'Interrupted by user' : 'Interrupted'
    case 'unconfirmed':
      return 'Couldn’t confirm'
    case null:
      return null
  }
}
