import {
  agentMainAgentVerdict,
  agentVerdictDisplayMark,
  type AgentVerdictDisplaySource
} from '../../../shared/agent-main-agent-verdict'

/** The line an agent row shows in place of its preview once its verdict marks it. A user's Stop
 *  says so; a turn a newer request replaced reads plainly interrupted, since no one is named; a
 *  turn cut short with nobody asking reads failed, as a failure does, until the user has seen it. */
export function agentVerdictStatusLine(entry: AgentVerdictDisplaySource): string | null {
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
