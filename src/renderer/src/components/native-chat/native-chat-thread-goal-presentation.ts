import { translate } from '@/i18n/i18n'
import type { AgentJournalThreadGoalStatus } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionThreadGoalStatusLabel } from '../../../../shared/agent-session/view/agent-session-thread-goal-presentation'

export function nativeChatThreadGoalStatusLabel(
  status: AgentJournalThreadGoalStatus,
  working: boolean
): string | null {
  switch (agentSessionThreadGoalStatusLabel(status, working)) {
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
