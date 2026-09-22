import type { AgentStatusState } from '../../../shared/agent-status-types'

export type AgentRim = 'waiting' | 'done'

/**
 * Shared rim precedence for the terminal pane and its sidebar row, so both
 * surfaces stay in sync. Needs-you (amber) wins over an unviewed completion
 * (green); an interrupted agent is not "needs you", and a working agent never
 * shows the completion rim (its completion marker may not be cleared yet).
 */
export function rimForAgentState(
  state: AgentStatusState | undefined,
  interrupted: boolean,
  completionUnread: boolean
): AgentRim | null {
  if (!interrupted && (state === 'waiting' || state === 'blocked')) {
    return 'waiting'
  }
  if (completionUnread && state !== 'working') {
    return 'done'
  }
  return null
}
