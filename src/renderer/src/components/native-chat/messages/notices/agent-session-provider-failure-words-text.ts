import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../../../shared/agent-session/failures/agent-session-failure-copy'

export const PROVIDER_FAILURE_PIECES = {
  providerSwitchConsentRequired: () =>
    translate(
      'components.native-chat.failureWords.providerSwitchConsentRequired',
      COPY.providerSwitchConsentRequired
    ),
  providerSwitchPlanMode: () =>
    translate(
      'components.native-chat.failureWords.providerSwitchPlanMode',
      COPY.providerSwitchPlanMode
    ),
  providerSwitchUnavailable: () =>
    translate(
      'components.native-chat.failureWords.providerSwitchUnavailable',
      COPY.providerSwitchUnavailable
    ),
  providerSwitchQueuedPermission: () =>
    translate(
      'components.native-chat.failureWords.providerSwitchQueuedPermission',
      COPY.providerSwitchQueuedPermission
    ),
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
    ),
  providerResponseFailedQuoted: (values) =>
    translate(
      'components.native-chat.failureWords.providerResponseFailedQuoted',
      COPY.providerResponseFailedQuoted,
      values
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
