import { translate } from '@/i18n/i18n'
import { AGENT_SESSION_GOAL_CONTROL_COPY as COPY } from '../../../../shared/agent-session-goal-control-copy'

const WORDS = new Map<string, () => string>([
  [
    COPY.settingsRejected,
    () => translate('components.native-chat.goalControl.settingsRejected', COPY.settingsRejected)
  ],
  [
    COPY.settingsUnconfirmed,
    () =>
      translate('components.native-chat.goalControl.settingsUnconfirmed', COPY.settingsUnconfirmed)
  ],
  [
    COPY.pauseUnconfirmed,
    () => translate('components.native-chat.goalControl.pauseUnconfirmed', COPY.pauseUnconfirmed)
  ],
  [
    COPY.stopUnconfirmed,
    () => translate('components.native-chat.goalControl.stopUnconfirmed', COPY.stopUnconfirmed)
  ]
])

export function agentSessionGoalControlWords(text: string): string {
  return WORDS.get(text)?.() ?? text
}
