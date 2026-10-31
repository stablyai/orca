import { translate } from '@/i18n/i18n'
import type { AgentJournalThreadGoalStatus } from '../../../../shared/agent-session-journal-types'

/** Active goals read as pursued only during a running turn; between turns they remain set. */
export function nativeChatThreadGoalStatusLabel(
  status: AgentJournalThreadGoalStatus,
  working: boolean
): string | null {
  switch (status) {
    case 'active':
      return working
        ? translate('components.native-chat.goal.pursuing', 'Pursuing goal')
        : translate('components.native-chat.goal.set', 'Goal set')
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

export function formatNativeChatThreadGoalElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}
