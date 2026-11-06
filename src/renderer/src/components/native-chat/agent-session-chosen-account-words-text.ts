import { translate } from '@/i18n/i18n'
import { AGENT_SESSION_FAILURE_COPY as COPY } from '../../../../shared/agent-session/failures/agent-session-failure-copy'

export const CHOSEN_ACCOUNT_FAILURE_PIECES = {
  historyInOtherAccount: () =>
    translate(
      'components.native-chat.failureWords.historyInOtherAccount',
      COPY.historyInOtherAccount
    ),
  claudeAccountFolderMissing: () =>
    translate(
      'components.native-chat.failureWords.claudeAccountFolderMissing',
      COPY.claudeAccountFolderMissing
    ),
  claudeAccountSetupFailed: () =>
    translate(
      'components.native-chat.failureWords.claudeAccountSetupFailed',
      COPY.claudeAccountSetupFailed
    ),
  claudeAccountUnknown: () =>
    translate(
      'components.native-chat.failureWords.claudeAccountUnknown',
      COPY.claudeAccountUnknown
    ),
  claudeAccountWslUnsupported: () =>
    translate(
      'components.native-chat.failureWords.claudeAccountWslUnsupported',
      COPY.claudeAccountWslUnsupported
    )
}
