import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AgentJournalThreadGoalStatus } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionThreadGoalStatusLabel } from '../../../../../../shared/agent-session/view/agent-session-thread-goal-presentation'

export function nativeChatThreadGoalStatusLabel(
  status: AgentJournalThreadGoalStatus,
  working: boolean,
  t: Translate = translate
): string | null {
  switch (agentSessionThreadGoalStatusLabel(status, working)) {
    case 'pursuing':
      return t('components.native-chat.goal.pursuing', 'Pursuing goal')
    case 'set':
      return t('components.native-chat.goal.set', 'Goal set')
    case 'paused':
      return t('components.native-chat.goal.paused', 'Paused goal')
    case 'blocked':
      return t('components.native-chat.goal.blocked', 'Goal blocked')
    case 'limited':
      return t('components.native-chat.goal.limited', 'Goal limited')
    case null:
      return null
  }
}
