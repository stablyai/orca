// Desktop words for an agent that stopped, kept beside the other failure pieces' translations.

import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session-failure-copy'

export const PROVIDER_EXIT_PIECES = {
  providerExitedRow: (values) =>
    translate(
      'components.native-chat.failureWords.providerExitedRow',
      COPY.providerExitedRow,
      values
    ),
  providerExitedRejection: (values) =>
    translate(
      'components.native-chat.failureWords.providerExitedRejection',
      COPY.providerExitedRejection,
      values
    ),
  providerExitedAnswer: (values) =>
    translate(
      'components.native-chat.failureWords.providerExitedAnswer',
      COPY.providerExitedAnswer,
      values
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
