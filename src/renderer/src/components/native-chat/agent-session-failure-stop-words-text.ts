// Desktop words for a Stop's failures, kept beside the other failure pieces' translations.

import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session-failure-copy'

export const STOP_FAILURE_PIECES = {
  cancelUnconfirmed: () =>
    translate('components.native-chat.failureWords.cancelUnconfirmed', COPY.cancelUnconfirmed),
  stopRefused: (values) =>
    translate('components.native-chat.failureWords.stopRefused', COPY.stopRefused, values),
  stopRefusedQuoted: (values) =>
    translate(
      'components.native-chat.failureWords.stopRefusedQuoted',
      COPY.stopRefusedQuoted,
      values
    ),
  noTurnToStop: (values) =>
    translate('components.native-chat.failureWords.noTurnToStop', COPY.noTurnToStop, values),
  couldNotStop: (values) =>
    translate('components.native-chat.failureWords.couldNotStop', COPY.couldNotStop, values),
  couldNotStopTheAgent: () =>
    translate('components.native-chat.failureWords.couldNotStopTheAgent', COPY.couldNotStopTheAgent)
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
