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
  | 'cliMissing'
>

export const AVAILABILITY_PIECES: Record<
  AvailabilityCopyId,
  (values: AgentSessionFailureCopyValues) => string
> = {
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
  cliMissing: (values) =>
    translate('components.native-chat.failureWords.cliMissing', COPY.cliMissing, values)
}
