import type { AgentJournalThreadGoalStatus } from '../journal/agent-session-journal-types'

export type AgentSessionThreadGoalStatusLabel =
  | 'pursuing'
  | 'set'
  | 'paused'
  | 'blocked'
  | 'limited'

/** Active goals read as pursued only during a running turn; between turns they remain set. Completed goals show nothing. */
export function agentSessionThreadGoalStatusLabel(
  status: AgentJournalThreadGoalStatus,
  working: boolean
): AgentSessionThreadGoalStatusLabel | null {
  switch (status) {
    case 'active':
      return working ? 'pursuing' : 'set'
    case 'paused':
      return 'paused'
    case 'blocked':
      return 'blocked'
    case 'usageLimited':
    case 'budgetLimited':
      return 'limited'
    case 'complete':
      return null
  }
}

export function formatAgentSessionThreadGoalElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}
