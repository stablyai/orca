import type { AgentJournalTurnLifecycleState } from './agent-session-journal-types'

/** Fallback text on a lifecycle row for readers that render status text raw.
 *  Must never overstate what the host knows: an unobserved end is not "completed". */
export function agentTurnLifecycleText(
  agent: 'Claude' | 'Codex',
  state: AgentJournalTurnLifecycleState
): string {
  switch (state) {
    case 'running':
      return `${agent} is working…`
    case 'completed':
      return `${agent} turn completed`
    case 'interrupted':
      return `${agent} turn interrupted`
    case 'unverifiable':
      return `${agent} turn outcome unverifiable`
  }
}
