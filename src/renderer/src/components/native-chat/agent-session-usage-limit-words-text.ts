import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session-failure-copy'

export const USAGE_LIMIT_PIECES = {
  usageLimitReached: (values) =>
    translate(
      'components.native-chat.failureWords.usageLimitReached',
      COPY.usageLimitReached,
      values
    ),
  usageLimitReachedNamed: (values) =>
    translate(
      'components.native-chat.failureWords.usageLimitReachedNamed',
      COPY.usageLimitReachedNamed,
      values
    ),
  usageLimitWindowSession: (values) =>
    translate(
      'components.native-chat.failureWords.usageLimitWindowSession',
      COPY.usageLimitWindowSession,
      values
    ),
  usageLimitWindowWeekly: (values) =>
    translate(
      'components.native-chat.failureWords.usageLimitWindowWeekly',
      COPY.usageLimitWindowWeekly,
      values
    ),
  usageLimitWindowWeeklyModel: (values) =>
    translate(
      'components.native-chat.failureWords.usageLimitWindowWeeklyModel',
      COPY.usageLimitWindowWeeklyModel,
      values
    ),
  usageLimitWindowCredits: (values) =>
    translate(
      'components.native-chat.failureWords.usageLimitWindowCredits',
      COPY.usageLimitWindowCredits,
      values
    ),
  usageLimitResetsAt: (values) =>
    translate(
      'components.native-chat.failureWords.usageLimitResetsAt',
      COPY.usageLimitResetsAt,
      values
    ),
  usageLimitSendAfterReset: (values) =>
    translate(
      'components.native-chat.failureWords.usageLimitSendAfterReset',
      COPY.usageLimitSendAfterReset,
      values
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
