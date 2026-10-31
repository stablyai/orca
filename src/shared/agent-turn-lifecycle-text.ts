import type { AgentJournalTurnLifecycleState } from './agent-session-journal-types'

/** Legacy raw status text must not call an unobserved end completed. */
export function agentTurnLifecycleText(
  agent: string,
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
