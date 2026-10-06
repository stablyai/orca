// Desktop words for a failure fact: each piece of the shared sentence translated whole, with the
// shared English as its fallback, so the host's row and desktop's notice never say it differently.

import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues,
  type AgentSessionFailureSay
} from '../../../../shared/agent-session-failure-copy'

// The pieces a refusal notice says too keep the notice's keys, so each has one translation.
const PIECES: Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string> =
  {
    theAgent: () => translate('components.native-chat.failureWords.theAgent', COPY.theAgent),
    providerStartFailed: (values) =>
      translate(
        'components.native-chat.failureWords.providerStartFailed',
        COPY.providerStartFailed,
        values
      ),
    runCommandAgain: (values) =>
      translate(
        'components.native-chat.failureWords.runCommandAgain',
        COPY.runCommandAgain,
        values
      ),
    sendToTryAgain: () =>
      translate('components.native-chat.failureWords.sendToTryAgain', COPY.sendToTryAgain),
    sendAgainToTryOnceMore: () =>
      translate(
        'components.native-chat.failureWords.sendAgainToTryOnceMore',
        COPY.sendAgainToTryOnceMore
      ),
    couldNotStart: (values) =>
      translate('components.native-chat.failureWords.couldNotStart', COPY.couldNotStart, values),
    couldNotRestart: (values) =>
      translate(
        'components.native-chat.failureWords.couldNotRestart',
        COPY.couldNotRestart,
        values
      ),
    terminalAgentHoldsChat: () =>
      translate(
        'components.native-chat.writeNotice.terminalAgentHoldsChat',
        COPY.terminalAgentHoldsChat
      ),
    quitTerminalAgent: () =>
      translate('components.native-chat.writeNotice.quitTerminalAgent', COPY.quitTerminalAgent),
    startNewChat: () =>
      translate('components.native-chat.writeNotice.startNewChat', COPY.startNewChat),
    notSignedIn: (values) =>
      translate('components.native-chat.failureWords.notSignedIn', COPY.notSignedIn, values),
    signInFirst: () =>
      translate('components.native-chat.failureWords.signInFirst', COPY.signInFirst),
    signInThenRunCommand: (values) =>
      translate(
        'components.native-chat.failureWords.signInThenRunCommand',
        COPY.signInThenRunCommand,
        values
      ),
    signInThenSend: () =>
      translate('components.native-chat.failureWords.signInThenSend', COPY.signInThenSend),
    historyTooLarge: () =>
      translate('components.native-chat.failureWords.historyTooLarge', COPY.historyTooLarge),
    managedAccountEnvOverride: () =>
      translate(
        'components.native-chat.failureWords.managedAccountEnvOverride',
        COPY.managedAccountEnvOverride
      ),
    accountSwitchInProgress: () =>
      translate(
        'components.native-chat.failureWords.accountSwitchInProgress',
        COPY.accountSwitchInProgress
      ),
    managedAccountUnsupported: () =>
      translate(
        'components.native-chat.failureWords.managedAccountUnsupported',
        COPY.managedAccountUnsupported
      ),
    chooseClaudeAccount: () =>
      translate(
        'components.native-chat.failureWords.chooseClaudeAccount',
        COPY.chooseClaudeAccount
      ),
    chooseClaudeAccountThenRunCommand: (values) =>
      translate(
        'components.native-chat.failureWords.chooseClaudeAccountThenRunCommand',
        COPY.chooseClaudeAccountThenRunCommand,
        values
      ),
    chooseClaudeAccountThenSend: () =>
      translate(
        'components.native-chat.failureWords.chooseClaudeAccountThenSend',
        COPY.chooseClaudeAccountThenSend
      ),
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
    providerRejected: () =>
      translate('components.native-chat.failureWords.providerRejected', COPY.providerRejected),
    providerRejectedQuoted: (values) =>
      translate(
        'components.native-chat.failureWords.providerRejectedQuoted',
        COPY.providerRejectedQuoted,
        values
      ),
    attachmentEmpty: () =>
      translate('components.native-chat.failureWords.attachmentEmpty', COPY.attachmentEmpty),
    attachmentTooLarge: () =>
      translate('components.native-chat.failureWords.attachmentTooLarge', COPY.attachmentTooLarge),
    attachmentLargerThan: (values) =>
      translate(
        'components.native-chat.failureWords.attachmentLargerThan',
        COPY.attachmentLargerThan,
        values
      ),
    attachmentTooMany: () =>
      translate('components.native-chat.failureWords.attachmentTooMany', COPY.attachmentTooMany),
    attachmentAtMost: (values) =>
      translate(
        'components.native-chat.failureWords.attachmentAtMost',
        COPY.attachmentAtMost,
        values
      ),
    attachmentTotalTooLarge: () =>
      translate(
        'components.native-chat.failureWords.attachmentTotalTooLarge',
        COPY.attachmentTotalTooLarge
      ),
    attachmentTotalMoreThan: (values) =>
      translate(
        'components.native-chat.failureWords.attachmentTotalMoreThan',
        COPY.attachmentTotalMoreThan,
        values
      ),
    attachmentUnsupportedType: (values) =>
      translate(
        'components.native-chat.failureWords.attachmentUnsupportedType',
        COPY.attachmentUnsupportedType,
        values
      ),
    attachmentNotAFile: () =>
      translate('components.native-chat.failureWords.attachmentNotAFile', COPY.attachmentNotAFile),
    attachmentNoSource: () =>
      translate('components.native-chat.failureWords.attachmentNoSource', COPY.attachmentNoSource),
    attachmentInvalid: () =>
      translate('components.native-chat.failureWords.attachmentInvalid', COPY.attachmentInvalid),
    attachmentUnreadable: () =>
      translate(
        'components.native-chat.failureWords.attachmentUnreadable',
        COPY.attachmentUnreadable
      ),
    emptyMessage: () =>
      translate('components.native-chat.failureWords.emptyMessage', COPY.emptyMessage),
    queueFull: () => translate('components.native-chat.failureWords.queueFull', COPY.queueFull),
    writeFailed: () =>
      translate('components.native-chat.failureWords.writeFailed', COPY.writeFailed),
    cancelled: () => translate('components.native-chat.failureWords.cancelled', COPY.cancelled),
    chatClosed: () => translate('components.native-chat.failureWords.chatClosed', COPY.chatClosed),
    hostRestarted: () =>
      translate('components.native-chat.failureWords.hostRestarted', COPY.hostRestarted),
    notDelivered: () =>
      translate('components.native-chat.failureWords.notDelivered', COPY.notDelivered),
    notDeliveredSendAgain: () =>
      translate(
        'components.native-chat.failureWords.notDeliveredSendAgain',
        COPY.notDeliveredSendAgain
      ),
    commandRefused: () =>
      translate('components.native-chat.failureWords.commandRefused', COPY.commandRefused),
    commandRefusedTryAgain: () =>
      translate(
        'components.native-chat.failureWords.commandRefusedTryAgain',
        COPY.commandRefusedTryAgain
      ),
    compactionFailed: () =>
      translate('components.native-chat.failureWords.compactionFailed', COPY.compactionFailed),
    compactionFailedQuoted: (values) =>
      translate(
        'components.native-chat.failureWords.compactionFailedQuoted',
        COPY.compactionFailedQuoted,
        values
      ),
    compactionUnconfirmed: () =>
      translate(
        'components.native-chat.failureWords.compactionUnconfirmed',
        COPY.compactionUnconfirmed
      ),
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
    answerUnconfirmed: () =>
      translate('components.native-chat.failureWords.answerUnconfirmed', COPY.answerUnconfirmed),
    hostFault: () => translate('components.native-chat.failureWords.hostFault', COPY.hostFault),
    hostFaultTryAgain: () =>
      translate('components.native-chat.failureWords.hostFaultTryAgain', COPY.hostFaultTryAgain),
    hostStopped: (values) =>
      translate('components.native-chat.failureWords.hostStopped', COPY.hostStopped, values),
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
    providerRetryAttempt: (values) =>
      translate(
        'components.native-chat.failureWords.providerRetryAttempt',
        COPY.providerRetryAttempt,
        values
      ),
    providerRetryAttemptOf: (values) =>
      translate(
        'components.native-chat.failureWords.providerRetryAttemptOf',
        COPY.providerRetryAttemptOf,
        values
      ),
    providerRetryLastError: (values) =>
      translate(
        'components.native-chat.failureWords.providerRetryLastError',
        COPY.providerRetryLastError,
        values
      ),
    previousExitUnverifiable: (values) =>
      translate(
        'components.native-chat.failureWords.previousExitUnverifiable',
        COPY.previousExitUnverifiable,
        values
      )
  }

export const sayAgentSessionFailureTranslated: AgentSessionFailureSay = (id, values = {}) =>
  PIECES[id](values)
