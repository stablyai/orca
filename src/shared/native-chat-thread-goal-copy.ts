import type { AgentJournalThreadGoalStatus } from './agent-session-journal-types'

export const NATIVE_CHAT_THREAD_GOAL_COPY = {
  pursuing: 'Pursuing goal',
  set: 'Goal set',
  paused: 'Paused goal',
  blocked: 'Goal blocked',
  limited: 'Goal limited',
  expand: 'Show full goal',
  collapse: 'Hide full goal'
} as const

export function nativeChatThreadGoalStatusKey(
  status: AgentJournalThreadGoalStatus,
  working: boolean
): 'pursuing' | 'set' | 'paused' | 'blocked' | 'limited' | null {
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
