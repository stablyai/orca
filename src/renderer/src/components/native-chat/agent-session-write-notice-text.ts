// Desktop words for a chat write that did not happen: each sentence translated whole, with the
// shared English as its fallback so desktop and mobile never say it differently.

import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_WRITE_NOTICE_COPY as COPY,
  agentSessionWriteNoticeParts,
  type AgentSessionWriteFailure,
  type AgentSessionWriteKind,
  type AgentSessionWriteNoticePart,
  type AgentSessionWriteNoticeSentence
} from '../../../../shared/agent-session-refusal-notice'

const SENTENCES: Record<AgentSessionWriteNoticeSentence, () => string> = {
  notDoneSend: () => translate('components.native-chat.writeNotice.notDoneSend', COPY.notDoneSend),
  tryAgainSend: () =>
    translate('components.native-chat.writeNotice.tryAgainSend', COPY.tryAgainSend),
  tryAgainComposerSend: () =>
    translate('components.native-chat.writeNotice.tryAgainComposerSend', COPY.tryAgainComposerSend),
  notDoneStop: () => translate('components.native-chat.writeNotice.notDoneStop', COPY.notDoneStop),
  tryAgainStop: () =>
    translate('components.native-chat.writeNotice.tryAgainStop', COPY.tryAgainStop),
  notDoneAnswer: () =>
    translate('components.native-chat.writeNotice.notDoneAnswer', COPY.notDoneAnswer),
  tryAgainAnswer: () =>
    translate('components.native-chat.writeNotice.tryAgainAnswer', COPY.tryAgainAnswer),
  notDoneOption: () =>
    translate('components.native-chat.writeNotice.notDoneOption', COPY.notDoneOption),
  tryAgainOption: () =>
    translate('components.native-chat.writeNotice.tryAgainOption', COPY.tryAgainOption),
  notDoneCommand: () =>
    translate('components.native-chat.writeNotice.notDoneCommand', COPY.notDoneCommand),
  tryAgainCommand: () =>
    translate('components.native-chat.writeNotice.tryAgainCommand', COPY.tryAgainCommand),
  notDoneGoal: () => translate('components.native-chat.writeNotice.notDoneGoal', COPY.notDoneGoal),
  tryAgainGoal: () =>
    translate('components.native-chat.writeNotice.tryAgainGoal', COPY.tryAgainGoal),
  restartFailed: () =>
    translate('components.native-chat.writeNotice.restartFailed', COPY.restartFailed),
  ownerUnconfirmed: () =>
    translate('components.native-chat.writeNotice.ownerUnconfirmed', COPY.ownerUnconfirmed),
  capacity: () => translate('components.native-chat.writeNotice.capacity', COPY.capacity),
  outcomeUnknown: () =>
    translate('components.native-chat.writeNotice.outcomeUnknown', COPY.outcomeUnknown),
  questionChanged: () =>
    translate('components.native-chat.writeNotice.questionChanged', COPY.questionChanged),
  sessionMissing: () =>
    translate('components.native-chat.writeNotice.sessionMissing', COPY.sessionMissing),
  historyUnreadable: () =>
    translate('components.native-chat.writeNotice.historyUnreadable', COPY.historyUnreadable),
  unsupported: () => translate('components.native-chat.writeNotice.unsupported', COPY.unsupported),
  unreachable: () => translate('components.native-chat.writeNotice.unreachable', COPY.unreachable),
  // The Retry row's long-standing wording, under its existing key.
  messageNotSent: () =>
    translate(
      'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
      COPY.messageNotSent
    )
}

export function agentSessionWriteNoticeText(parts: readonly AgentSessionWriteNoticePart[]): string {
  return parts.map((part) => (typeof part === 'string' ? SENTENCES[part]() : part.text)).join(' ')
}

export function agentSessionWriteFailureText(
  failure: AgentSessionWriteFailure,
  write: AgentSessionWriteKind
): string {
  return agentSessionWriteNoticeText(agentSessionWriteNoticeParts(failure, write))
}
