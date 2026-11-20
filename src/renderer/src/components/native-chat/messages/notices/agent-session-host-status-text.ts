import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_HOST_STATUS_COPY as HOST_STATUS_COPY,
  type AgentSessionHostStatusPresentation
} from '../../../../../../shared/agent-session/view/agent-session-host-status-rows'

const HOST_STATUS_WORDS: Record<AgentSessionHostStatusPresentation, () => string> = {
  'history-repaired': () =>
    translate(
      'components.native-chat.notices.historyRepaired',
      HOST_STATUS_COPY['history-repaired']
    ),
  'history-item-too-large': () =>
    translate(
      'components.native-chat.notices.historyItemTooLarge',
      HOST_STATUS_COPY['history-item-too-large']
    ),
  'continued-outside-catching-up': () =>
    translate(
      'components.native-chat.notices.continuedOutsideCatchingUp',
      HOST_STATUS_COPY['continued-outside-catching-up']
    ),
  'continued-outside': () =>
    translate(
      'components.native-chat.notices.continuedOutside',
      HOST_STATUS_COPY['continued-outside']
    ),
  'continued-outside-recent': () =>
    translate(
      'components.native-chat.notices.continuedOutsideRecent',
      HOST_STATUS_COPY['continued-outside-recent']
    ),
  'continued-outside-unloaded': () =>
    translate(
      'components.native-chat.notices.continuedOutsideUnloaded',
      HOST_STATUS_COPY['continued-outside-unloaded']
    ),
  'continued-outside-rewound': () =>
    translate(
      'components.native-chat.notices.continuedOutsideRewound',
      HOST_STATUS_COPY['continued-outside-rewound']
    )
}

export function agentSessionHostStatusText(
  presentation: AgentSessionHostStatusPresentation
): string {
  return HOST_STATUS_WORDS[presentation]()
}
