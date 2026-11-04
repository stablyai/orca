import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session/failures/agent-session-failure-copy'

export const START_FAILURE_PIECES = {
  savedConversationMissing: (values) =>
    translate(
      'components.native-chat.failureWords.savedConversationMissing',
      COPY.savedConversationMissing,
      values
    ),
  providerStartFailed: (values) =>
    translate(
      'components.native-chat.failureWords.providerStartFailed',
      COPY.providerStartFailed,
      values
    ),
  couldNotStart: (values) =>
    translate('components.native-chat.failureWords.couldNotStart', COPY.couldNotStart, values),
  couldNotRestart: (values) =>
    translate('components.native-chat.failureWords.couldNotRestart', COPY.couldNotRestart, values),
  startTimedOut: (values) =>
    translate('components.native-chat.failureWords.startTimedOut', COPY.startTimedOut, values),
  startTimedOutKeepsHappening: () =>
    translate(
      'components.native-chat.failureWords.startTimedOutKeepsHappening',
      COPY.startTimedOutKeepsHappening
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
