// Desktop words for a failure fact: each piece of the shared sentence translated whole, with the
// shared English as its fallback, so the host's row and desktop's notice never say it differently.

import { translate } from '@/i18n/i18n'
import { COMMAND_REFUSAL_PIECES } from './agent-session-command-refusal-words-text'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues,
  type AgentSessionFailureSay
} from '../../../../shared/agent-session-failure-copy'
import { AVAILABILITY_PIECES } from './agent-session-availability-words-text'
import { ATTACHMENT_FAILURE_PIECES } from './agent-session-failure-attachment-words-text'

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
    sendItAgain: () =>
      translate('components.native-chat.writeNotice.tryAgainComposerSend', COPY.sendItAgain),
    couldNotStart: (values) =>
      translate('components.native-chat.failureWords.couldNotStart', COPY.couldNotStart, values),
    couldNotRestart: (values) =>
      translate(
        'components.native-chat.failureWords.couldNotRestart',
        COPY.couldNotRestart,
        values
      ),
    argumentsUnsupportedOption: (values) =>
      translate(
        'components.native-chat.failureWords.argumentsUnsupportedOption',
        COPY.argumentsUnsupportedOption,
        values
      ),
    argumentsMissingValue: (values) =>
      translate(
        'components.native-chat.failureWords.argumentsMissingValue',
        COPY.argumentsMissingValue,
        values
      ),
    argumentsMultipleValues: (values) =>
      translate(
        'components.native-chat.failureWords.argumentsMultipleValues',
        COPY.argumentsMultipleValues,
        values
      ),
    argumentsPositionalPrompt: () =>
      translate(
        'components.native-chat.failureWords.argumentsPositionalPrompt',
        COPY.argumentsPositionalPrompt
      ),
    editSavedArguments: () =>
      translate('components.native-chat.failureWords.editSavedArguments', COPY.editSavedArguments),
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
    ...AVAILABILITY_PIECES,
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
    launchFolderMissing: () =>
      translate(
        'components.native-chat.failureWords.launchFolderMissing',
        COPY.launchFolderMissing
      ),
    historyInOtherAccount: () =>
      translate(
        'components.native-chat.failureWords.historyInOtherAccount',
        COPY.historyInOtherAccount
      ),
    agentCommandNotRunnable: (values) =>
      translate(
        'components.native-chat.failureWords.agentCommandNotRunnable',
        COPY.agentCommandNotRunnable,
        values
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
    providerRejected: (values) =>
      translate(
        'components.native-chat.failureWords.providerRejected',
        COPY.providerRejected,
        values
      ),
    providerRejectedQuoted: (values) =>
      translate(
        'components.native-chat.failureWords.providerRejectedQuoted',
        COPY.providerRejectedQuoted,
        values
      ),
    ...ATTACHMENT_FAILURE_PIECES,
    emptyMessage: () =>
      translate('components.native-chat.failureWords.emptyMessage', COPY.emptyMessage),
    queueFull: () => translate('components.native-chat.failureWords.queueFull', COPY.queueFull),
    writeFailed: (values) =>
      translate('components.native-chat.failureWords.writeFailed', COPY.writeFailed, values),
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
    queueSendRetryWhenDone: (values) =>
      translate(
        'components.native-chat.failureWords.queueSendRetryWhenDone',
        COPY.queueSendRetryWhenDone,
        values
      ),
    queueSendRetry: () =>
      translate('components.native-chat.failureWords.queueSendRetry', COPY.queueSendRetry),
    ...COMMAND_REFUSAL_PIECES,
    compactionFailed: (values) =>
      translate(
        'components.native-chat.failureWords.compactionFailed',
        COPY.compactionFailed,
        values
      ),
    runCommandWhenDone: (values) =>
      translate(
        'components.native-chat.failureWords.runCommandWhenDone',
        COPY.runCommandWhenDone,
        values
      ),
    compactionFailedQuoted: (values) =>
      translate(
        'components.native-chat.failureWords.compactionFailedQuoted',
        COPY.compactionFailedQuoted,
        values
      ),
    compactionUnconfirmed: (values) =>
      translate(
        'components.native-chat.failureWords.compactionUnconfirmed',
        COPY.compactionUnconfirmed,
        values
      ),
    cancelUnconfirmed: (values) =>
      translate(
        'components.native-chat.failureWords.cancelUnconfirmed',
        COPY.cancelUnconfirmed,
        values
      ),
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
    answerUnconfirmed: (values) =>
      translate(
        'components.native-chat.failureWords.answerUnconfirmed',
        COPY.answerUnconfirmed,
        values
      ),
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
    providerError: (values) =>
      translate('components.native-chat.failureWords.providerError', COPY.providerError, values),
    providerErrorQuoted: (values) =>
      translate(
        'components.native-chat.failureWords.providerErrorQuoted',
        COPY.providerErrorQuoted,
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
      ),
    previousExitUnverifiable: (values) =>
      translate(
        'components.native-chat.failureWords.previousExitUnverifiable',
        COPY.previousExitUnverifiable,
        values
      ),
    sessionNotRestored: (values) =>
      translate(
        'components.native-chat.failureWords.sessionNotRestored',
        COPY.sessionNotRestored,
        values
      )
  }

export const sayAgentSessionFailureTranslated: AgentSessionFailureSay = (id, values = {}) =>
  PIECES[id](values)
