import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session-failure-copy'

// Desktop words for why no chat can start under an account, before and after a send.

type AvailabilityCopyId = Extract<
  AgentSessionFailureCopyId,
  | 'claudeSystemNotSignedIn'
  | 'claudeManagedNotSignedIn'
  | 'codexSystemNotSignedIn'
  | 'codexManagedNotSignedIn'
  | 'antigravityNotSignedIn'
  | 'agentCommandNotSignedIn'
  | 'interactiveAgentNotSignedIn'
  | 'agentNotSignedIn'
  | 'thenSendAgain'
  | 'cliMissing'
  | 'cliTooOld'
>

export const AVAILABILITY_PIECES: Record<
  AvailabilityCopyId,
  (values: AgentSessionFailureCopyValues) => string
> = {
  agentCommandNotSignedIn: (values) =>
    translate(
      'components.native-chat.failureWords.agentCommandNotSignedIn',
      COPY.agentCommandNotSignedIn,
      values
    ),
  interactiveAgentNotSignedIn: (values) =>
    translate(
      'components.native-chat.failureWords.interactiveAgentNotSignedIn',
      COPY.interactiveAgentNotSignedIn,
      values
    ),
  agentNotSignedIn: (values) =>
    translate(
      'components.native-chat.failureWords.agentNotSignedIn',
      COPY.agentNotSignedIn,
      values
    ),
  thenSendAgain: () =>
    translate('components.native-chat.failureWords.thenSendAgain', COPY.thenSendAgain),
  claudeSystemNotSignedIn: (values) =>
    translate(
      'components.native-chat.failureWords.claudeSystemNotSignedIn',
      COPY.claudeSystemNotSignedIn,
      values
    ),
  claudeManagedNotSignedIn: (values) =>
    translate(
      'components.native-chat.failureWords.claudeManagedNotSignedIn',
      COPY.claudeManagedNotSignedIn,
      values
    ),
  codexSystemNotSignedIn: (values) =>
    translate(
      'components.native-chat.failureWords.codexSystemNotSignedIn',
      COPY.codexSystemNotSignedIn,
      values
    ),
  codexManagedNotSignedIn: (values) =>
    translate(
      'components.native-chat.failureWords.codexManagedNotSignedIn',
      COPY.codexManagedNotSignedIn,
      values
    ),
  antigravityNotSignedIn: (values) =>
    translate(
      'components.native-chat.failureWords.antigravityNotSignedIn',
      COPY.antigravityNotSignedIn,
      values
    ),
  cliMissing: (values) =>
    translate('components.native-chat.failureWords.cliMissing', COPY.cliMissing, values),
  cliTooOld: (values) =>
    translate('components.native-chat.failureWords.cliTooOld', COPY.cliTooOld, values)
}
