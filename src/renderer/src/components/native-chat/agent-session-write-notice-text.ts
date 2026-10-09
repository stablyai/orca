// Desktop words for a chat write that did not happen: each sentence translated whole, with the
// shared English as its fallback so desktop and mobile never say it differently.

import { translate } from '@/i18n/i18n'
import { agentSessionFailureSentence } from '../../../../shared/agent-session-failure-words'
import { agentSessionWriteNoticeParts } from '../../../../shared/agent-session-refusal-notice'
import {
  AGENT_SESSION_WRITE_NOTICE_COPY as COPY,
  type AgentSessionWriteNoticePart,
  type AgentSessionWriteNoticeSentence
} from '../../../../shared/agent-session-write-notice-copy'
import type {
  AgentSessionWriteFailure,
  AgentSessionWriteKind
} from '../../../../shared/agent-session-write-failure'
import { joinSentences } from '../../../../shared/sentence-joining'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'

const SENTENCES: Record<AgentSessionWriteNoticeSentence, () => string> = {
  notDoneReadHistory: () =>
    translate('components.native-chat.writeNotice.notDoneReadHistory', COPY.notDoneReadHistory),
  notDoneSend: () => translate('components.native-chat.writeNotice.notDoneSend', COPY.notDoneSend),
  tryAgainComposerSend: () =>
    translate('components.native-chat.writeNotice.tryAgainComposerSend', COPY.tryAgainComposerSend),
  messageNotSaved: () =>
    translate('components.native-chat.writeNotice.messageNotSaved', COPY.messageNotSaved),
  notDoneStop: () => translate('components.native-chat.writeNotice.notDoneStop', COPY.notDoneStop),
  notDoneStopTask: () =>
    translate('components.native-chat.writeNotice.notDoneStopTask', COPY.notDoneStopTask),
  notDoneStopTasks: () =>
    translate('components.native-chat.writeNotice.notDoneStopTasks', COPY.notDoneStopTasks),
  notDoneAnswer: () =>
    translate('components.native-chat.writeNotice.notDoneAnswer', COPY.notDoneAnswer),
  notDoneOption: () =>
    translate('components.native-chat.writeNotice.notDoneOption', COPY.notDoneOption),
  notDoneCommand: () =>
    translate('components.native-chat.writeNotice.notDoneCommand', COPY.notDoneCommand),
  notDoneGoal: () => translate('components.native-chat.writeNotice.notDoneGoal', COPY.notDoneGoal),
  restartFailed: () =>
    translate('components.native-chat.writeNotice.restartFailed', COPY.restartFailed),
  capacity: () => translate('components.native-chat.writeNotice.capacity', COPY.capacity),
  outcomeUnknown: () =>
    translate('components.native-chat.writeNotice.outcomeUnknown', COPY.outcomeUnknown),
  sendOutcomeLost: () =>
    translate('components.native-chat.writeNotice.sendOutcomeLost', COPY.sendOutcomeLost),
  questionChanged: () =>
    translate('components.native-chat.writeNotice.questionChanged', COPY.questionChanged),
  historyUnreadable: () =>
    translate('components.native-chat.writeNotice.historyUnreadable', COPY.historyUnreadable),
  historyUnusable: () =>
    translate('components.native-chat.writeNotice.historyUnusable', COPY.historyUnusable),
  historyUnavailable: () =>
    translate('components.native-chat.writeNotice.historyUnavailable', COPY.historyUnavailable),
  savedByNewerOrca: () =>
    translate('components.native-chat.writeNotice.savedByNewerOrca', COPY.savedByNewerOrca),
  updateOrcaToKeepUsing: () =>
    translate(
      'components.native-chat.writeNotice.updateOrcaToKeepUsing',
      COPY.updateOrcaToKeepUsing
    ),
  chatSavedByNewerOrca: () =>
    translate('components.native-chat.writeNotice.chatSavedByNewerOrca', COPY.chatSavedByNewerOrca),
  updateOrcaToOpenChat: () =>
    translate('components.native-chat.writeNotice.updateOrcaToOpenChat', COPY.updateOrcaToOpenChat),
  unsupported: () => translate('components.native-chat.writeNotice.unsupported', COPY.unsupported),
  notAvailable: () =>
    translate('components.native-chat.writeNotice.notAvailable', COPY.notAvailable),
  cannotRunHere: () =>
    translate('components.native-chat.writeNotice.cannotRunHere', COPY.cannotRunHere),
  unreachable: () => translate('components.native-chat.writeNotice.unreachable', COPY.unreachable),
  recordFailed: () =>
    translate('components.native-chat.writeNotice.recordFailed', COPY.recordFailed),
  attachmentExpired: () =>
    translate('components.native-chat.writeNotice.attachmentExpired', COPY.attachmentExpired),
  reattachFile: () =>
    translate('components.native-chat.writeNotice.reattachFile', COPY.reattachFile),
  conversationCleared: () =>
    translate('components.native-chat.writeNotice.conversationCleared', COPY.conversationCleared),
  openCurrentConversation: () =>
    translate(
      'components.native-chat.writeNotice.openCurrentConversation',
      COPY.openCurrentConversation
    ),
  clearUnfinished: () =>
    translate('components.native-chat.writeNotice.clearUnfinished', COPY.clearUnfinished),
  commandRunning: () =>
    translate('components.native-chat.writeNotice.commandRunning', COPY.commandRunning),
  waitForCommand: () =>
    translate('components.native-chat.writeNotice.waitForCommand', COPY.waitForCommand),
  agentStarting: () =>
    translate('components.native-chat.writeNotice.agentStarting', COPY.agentStarting),
  waitForStart: () =>
    translate('components.native-chat.writeNotice.waitForStart', COPY.waitForStart),
  turnActive: () => translate('components.native-chat.writeNotice.turnActive', COPY.turnActive),
  waitForTurn: () => translate('components.native-chat.writeNotice.waitForTurn', COPY.waitForTurn),
  promptPending: () =>
    translate('components.native-chat.writeNotice.promptPending', COPY.promptPending),
  answerFirst: () => translate('components.native-chat.writeNotice.answerFirst', COPY.answerFirst),
  backgroundTasksRunning: () =>
    translate(
      'components.native-chat.writeNotice.backgroundTasksRunning',
      COPY.backgroundTasksRunning
    ),
  waitForBackgroundTasks: () =>
    translate(
      'components.native-chat.writeNotice.waitForBackgroundTasks',
      COPY.waitForBackgroundTasks
    ),
  messagesUnsettled: () =>
    translate('components.native-chat.writeNotice.messagesUnsettled', COPY.messagesUnsettled),
  settleEarlierMessage: () =>
    translate('components.native-chat.writeNotice.settleEarlierMessage', COPY.settleEarlierMessage),
  agentStillWorking: () =>
    translate('components.native-chat.writeNotice.agentStillWorking', COPY.agentStillWorking),
  runClearWhenDone: () =>
    translate('components.native-chat.writeNotice.runClearWhenDone', COPY.runClearWhenDone),
  clearAfterAnswer: () =>
    translate('components.native-chat.writeNotice.clearAfterAnswer', COPY.clearAfterAnswer),
  runCompactWhenDone: () =>
    translate('components.native-chat.writeNotice.runCompactWhenDone', COPY.runCompactWhenDone),
  compactAfterAnswer: () =>
    translate('components.native-chat.writeNotice.compactAfterAnswer', COPY.compactAfterAnswer),
  clearAfterRetry: () =>
    translate('components.native-chat.writeNotice.clearAfterRetry', COPY.clearAfterRetry),
  compactAfterRetry: () =>
    translate('components.native-chat.writeNotice.compactAfterRetry', COPY.compactAfterRetry),
  clearAfterSending: () =>
    translate('components.native-chat.writeNotice.clearAfterSending', COPY.clearAfterSending),
  compactAfterSending: () =>
    translate('components.native-chat.writeNotice.compactAfterSending', COPY.compactAfterSending),
  queueTooLarge: () =>
    translate('components.native-chat.writeNotice.queueTooLarge', COPY.queueTooLarge),
  shrinkQueue: () => translate('components.native-chat.writeNotice.shrinkQueue', COPY.shrinkQueue),
  optionRejected: () =>
    translate('components.native-chat.writeNotice.optionRejected', COPY.optionRejected),
  goalsUnsupported: () =>
    translate('components.native-chat.writeNotice.goalsUnsupported', COPY.goalsUnsupported),
  agentRefused: () =>
    translate('components.native-chat.writeNotice.agentRefused', COPY.agentRefused),
  ownerUnproven: () =>
    translate('components.native-chat.writeNotice.ownerUnproven', COPY.ownerUnproven),
  reopenChat: () => translate('components.native-chat.writeNotice.reopenChat', COPY.reopenChat),
  terminalAgentHoldsChat: () =>
    translate(
      'components.native-chat.writeNotice.terminalAgentHoldsChat',
      COPY.terminalAgentHoldsChat
    ),
  quitTerminalAgent: () =>
    translate('components.native-chat.writeNotice.quitTerminalAgent', COPY.quitTerminalAgent),
  hostReconciling: () =>
    translate('components.native-chat.writeNotice.hostReconciling', COPY.hostReconciling),
  waitMoment: () => translate('components.native-chat.writeNotice.waitMoment', COPY.waitMoment),
  recordUnreadable: () =>
    translate('components.native-chat.writeNotice.recordUnreadable', COPY.recordUnreadable),
  chatNotFound: () =>
    translate('components.native-chat.writeNotice.chatNotFound', COPY.chatNotFound),
  startNewChat: () =>
    translate('components.native-chat.writeNotice.startNewChat', COPY.startNewChat),
  tryAgain: () => translate('components.native-chat.writeNotice.tryAgain', COPY.tryAgain)
}

export function agentSessionWriteNoticeText(parts: readonly AgentSessionWriteNoticePart[]): string {
  return joinSentences(
    parts.map((part) =>
      typeof part === 'string'
        ? SENTENCES[part]()
        : 'text' in part
          ? part.text
          : agentSessionFailureSentence(
              part.failure,
              part.surface,
              part.context,
              sayAgentSessionFailureTranslated
            )
    )
  )
}

export function agentSessionWriteFailureText(
  failure: AgentSessionWriteFailure,
  write: AgentSessionWriteKind
): string {
  return agentSessionWriteNoticeText(agentSessionWriteNoticeParts(failure, write))
}
