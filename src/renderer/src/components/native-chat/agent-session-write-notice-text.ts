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
  tryAgainComposerSend: () =>
    translate('components.native-chat.writeNotice.tryAgainComposerSend', COPY.tryAgainComposerSend),
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
  questionChanged: () =>
    translate('components.native-chat.writeNotice.questionChanged', COPY.questionChanged),
  historyUnreadable: () =>
    translate('components.native-chat.writeNotice.historyUnreadable', COPY.historyUnreadable),
  unsupported: () => translate('components.native-chat.writeNotice.unsupported', COPY.unsupported),
  unreachable: () => translate('components.native-chat.writeNotice.unreachable', COPY.unreachable)
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
