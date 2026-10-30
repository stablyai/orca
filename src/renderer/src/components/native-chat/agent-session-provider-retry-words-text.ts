import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session-failure-copy'

export const PROVIDER_RETRY_PIECES = {
  providerRateLimited: (values) =>
    translate(
      'components.native-chat.failureWords.providerRateLimited',
      COPY.providerRateLimited,
      values
    ),
  providerRetrying: (values) =>
    translate(
      'components.native-chat.failureWords.providerRetrying',
      COPY.providerRetrying,
      values
    ),
  providerRetryingQuoted: (values) =>
    translate(
      'components.native-chat.failureWords.providerRetryingQuoted',
      COPY.providerRetryingQuoted,
      values
    ),
  providerRetryNumber: (values) =>
    translate(
      'components.native-chat.failureWords.providerRetryNumber',
      COPY.providerRetryNumber,
      values
    ),
  providerRetryNumberOf: (values) =>
    translate(
      'components.native-chat.failureWords.providerRetryNumberOf',
      COPY.providerRetryNumberOf,
      values
    ),
  providerRetryLastError: (values) =>
    translate(
      'components.native-chat.failureWords.providerRetryLastError',
      COPY.providerRetryLastError,
      values
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
