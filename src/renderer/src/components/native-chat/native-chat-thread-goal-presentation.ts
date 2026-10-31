import { translate } from '@/i18n/i18n'
import type { AgentJournalThreadGoalStatus } from '../../../../shared/agent-session-journal-types'
import { nativeChatThreadGoalStatusKey } from '../../../../shared/native-chat-thread-goal-copy'

/** Active goals read as pursued only during a running turn; between turns they remain set. */
export function nativeChatThreadGoalStatusLabel(
  status: AgentJournalThreadGoalStatus,
  working: boolean
): string | null {
  const key = nativeChatThreadGoalStatusKey(status, working)
  switch (key) {
    case 'pursuing':
      return translate('components.native-chat.goal.pursuing', 'Pursuing goal')
    case 'set':
      return translate('components.native-chat.goal.set', 'Goal set')
    case 'paused':
      return translate('components.native-chat.goal.paused', 'Paused goal')
    case 'blocked':
      return translate('components.native-chat.goal.blocked', 'Goal blocked')
    case 'limited':
      return translate('components.native-chat.goal.limited', 'Goal limited')
    case null:
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
