import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../../../shared/agent-session/failures/agent-session-failure-copy'

export const PROVIDER_FAILURE_PIECES = {
  selectedModel: (values) =>
    translate('components.native-chat.failureWords.selectedModel', COPY.selectedModel, values),
  providerUnavailable: (values) =>
    translate(
      'components.native-chat.failureWords.providerUnavailable',
      COPY.providerUnavailable,
      values
    ),
  providerSafetyStopped: (values) =>
    translate(
      'components.native-chat.failureWords.providerSafetyStopped',
      COPY.providerSafetyStopped,
      values
    ),
  providerResponseFailed: (values) =>
    translate(
      'components.native-chat.failureWords.providerResponseFailed',
      COPY.providerResponseFailed,
      values
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
