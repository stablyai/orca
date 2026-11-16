import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyValues
} from '../../../../../../shared/agent-session/failures/agent-session-failure-copy'

export const INTERACTION_MODE_FAILURE_PIECES = {
  interactionModeUnavailable: (values) =>
    translate(
      'components.native-chat.failureWords.interactionModeUnavailable',
      COPY.interactionModeUnavailable,
      values
    ),
  interactionModeUnconfirmed: (values) =>
    translate(
      'components.native-chat.failureWords.interactionModeUnconfirmed',
      COPY.interactionModeUnconfirmed,
      values
    ),
  interactionModeFailed: (values) =>
    translate(
      'components.native-chat.failureWords.interactionModeFailed',
      COPY.interactionModeFailed,
      values
    )
} satisfies Record<
  'interactionModeUnavailable' | 'interactionModeUnconfirmed' | 'interactionModeFailed',
  (values: AgentSessionFailureCopyValues) => string
>
