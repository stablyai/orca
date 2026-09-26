import { translate } from '@/i18n/i18n'
import type { AgentJournalThreadGoalStatus } from '../../../../shared/agent-session-journal-types'

/** The banner's lead label, or null for a status the banner does not show. */
export function nativeChatThreadGoalStatusLabel(
  status: AgentJournalThreadGoalStatus
): string | null {
  switch (status) {
    case 'active':
      return translate('components.native-chat.goal.pursuing', 'Pursuing goal')
    case 'paused':
      return translate('components.native-chat.goal.paused', 'Paused goal')
    case 'blocked':
      return translate('components.native-chat.goal.blocked', 'Goal blocked')
    case 'usageLimited':
    case 'budgetLimited':
      return translate('components.native-chat.goal.limited', 'Goal limited')
    case 'complete':
      return null
  }
}

/** Compact elapsed time: `25s`, `1m 7s`, `2h 3m`. */
export function formatNativeChatThreadGoalElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}
