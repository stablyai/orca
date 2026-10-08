// The one way a chat surface puts a write that did not happen into words.
//
// A refusal's `message` is never shown. Every code has at least one host emitter whose message is
// written for a log or carries a marker (the census is pinned in the test), so the refusal's
// reason, when the host names one, and otherwise its code, pick the copy with the write. A code's
// own row names a cause only where every emitter of the code means it; it is also the words for a
// host too old to send a reason. A notice says how to get past a refusal only where the person has
// a step to take; retrying is the control that sent the write, except on the phone, whose message
// goes back to the composer, and a history that couldn't open right now says to try again unless
// something beside the words retries it.
// Surfaces keep the fact and choose the words when they show it, so nothing saved carries copy.

import {
  agentSessionFailureSentence,
  type AgentSessionFailureWordsContext
} from './agent-session-failure-words'
import {
  AGENT_SESSION_HISTORY_UNREAD_CAUSES,
  AGENT_SESSION_WRITE_NOTICE_COPY,
  type AgentSessionWriteNoticePart,
  type AgentSessionWriteNoticeSentence
} from './agent-session-write-notice-copy'
import type { AgentSessionWireRefusal } from './agent-session-wire-refusals'
import {
  agentSessionRefusalFailure,
  parseAgentSessionWriteFailure,
  type AgentSessionWriteFailure,
  type AgentSessionWriteKind,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'
import { agentSessionRefusalReasonWords } from './agent-session-refusal-reason-words'

export {
  agentSessionRefusalReasonWords,
  type AgentSessionRefusalAction,
  type AgentSessionRefusalReasonWords
} from './agent-session-refusal-reason-words'

const NOT_DONE: Record<AgentSessionWriteKind, AgentSessionWriteNoticeSentence> = {
  'read-history': 'notDoneReadHistory',
  send: 'notDoneSend',
  'composer-send': 'notDoneSend',
  stop: 'notDoneStop',
  'stop-task': 'notDoneStopTask',
  'stop-tasks': 'notDoneStopTasks',
  answer: 'notDoneAnswer',
  option: 'notDoneOption',
  command: 'notDoneCommand',
  goal: 'notDoneGoal'
}

/** That the write did not happen, for one that a second attempt can carry out. Only the phone says
 *  how: its message goes back to the composer and it has no Retry control. Everywhere else the
 *  control that sent the write is the way to try again. */
export function agentSessionWriteNotDoneParts(
  write: AgentSessionWriteKind
): AgentSessionWriteNoticeSentence[] {
  return write === 'composer-send' ? ['notDoneSend', 'tryAgainComposerSend'] : [NOT_DONE[write]]
}

/** A cause, and that the request did not happen unless the cause already says so. */
function causeParts(
  cause: AgentSessionWriteNoticeSentence,
  write: AgentSessionWriteKind
): AgentSessionWriteNoticeSentence[] {
  // Says the request didn't happen, but a read asked for nothing "this" could name.
  if (cause === 'notAvailable') {
    return write === 'read-history' ? [NOT_DONE[write]] : [cause]
  }
  const saysNotDone =
    (write === 'read-history' && AGENT_SESSION_HISTORY_UNREAD_CAUSES.has(cause)) ||
    (cause === 'questionChanged' && write === 'answer')
  return saysNotDone ? [cause] : [cause, NOT_DONE[write]]
}

/** The notice a named reason has of its own; undefined leaves the code's words. */
function reasonParts(
  failure: AgentSessionWriteRefusal,
  write: AgentSessionWriteKind,
  context: AgentSessionFailureWordsContext
): AgentSessionWriteNoticePart[] | undefined {
  if (
    failure.code === 'agent_session_operation_invalid' &&
    failure.details?.argumentProblem &&
    (write === 'send' || write === 'composer-send')
  ) {
    const argumentProblem = failure.details.argumentProblem
    return [
      NOT_DONE[write],
      {
        failure: { kind: 'startFailed', argumentProblem },
        surface: 'rejection',
        context: { ...context, agentName: argumentProblem.agent }
      }
    ]
  }
  const words = agentSessionRefusalReasonWords(failure)
  if (!words || 'words' in words) {
    return undefined
  }
  if ('fact' in words) {
    return write === 'send' || write === 'composer-send'
      ? [
          NOT_DONE[write],
          {
            failure: {
              kind: words.fact,
              ...(words.fact === 'notSignedIn' &&
              failure.code === 'agent_session_operation_invalid' &&
              failure.details?.account
                ? { account: failure.details.account }
                : {})
            },
            surface: 'rejection',
            context
          }
        ]
      : undefined
  }
  const { cause, step } = write === 'read-history' && words.history ? words.history : words
  const said = causeParts(cause, write)
  // A Retry beside the words is the step for a reason whose action is to retry.
  const retried = context.retryControl && words.action === 'retry'
  return step && !retried ? [...said, step] : said
}

/** What stopped a refused start, for a line that already says the chat did not start and shows its
 *  own Retry. Empty when the refusal names no reason with words of its own. */
export function agentSessionRefusalCauseParts(
  failure: AgentSessionWriteFailure,
  context: { agentName?: string } = {}
): AgentSessionWriteNoticePart[] {
  const parts =
    failure.kind === 'refused'
      ? reasonParts(failure, 'send', { ...context, retryControl: true })
      : undefined
  return parts?.filter((part) => part !== 'notDoneSend') ?? []
}

/** `context.retryControl`: a Retry beside the words is the step for a reason whose action is to
 *  retry, and for sending again; any other step stays. */
export function agentSessionWriteNoticeParts(
  failure: AgentSessionWriteFailure,
  write: AgentSessionWriteKind,
  context: AgentSessionFailureWordsContext = {}
): AgentSessionWriteNoticePart[] {
  const notDone = NOT_DONE[write]
  if (failure.kind === 'failed') {
    return agentSessionWriteNotDoneParts(write)
  }
  if (failure.kind === 'unconfirmed') {
    return ['outcomeUnknown']
  }
  const byReason = reasonParts(failure, write, context)
  if (byReason) {
    return byReason
  }
  switch (failure.code) {
    // The cause is in the chat's own status row. Some restarts can be retried and some need a new
    // chat, and the code does not say which.
    case 'agent_session_owner_restart_failed':
      return ['restartFailed', notDone]
    // Several different owner states share these codes. Each is refused before the id is recorded,
    // so the phone's resend under the same id can go through.
    case 'agent_session_checkpoint_stale':
    case 'agent_session_conflict':
    case 'agent_session_ownership_unknown':
    case 'execution_owner_reconciling':
      return agentSessionWriteNotDoneParts(write)
    // Counted across every chat and freed only as a day's requests age out, so trying again now
    // would likely be refused again.
    case 'agent_session_operation_capacity':
      return ['capacity', notDone]
    // The phone resends under the same id, which the host refuses the same way again. The rest
    // stand for reasons the code does not name (a cleared conversation, a pending question, a
    // provider's own rejection...), so any cause or next step could be false.
    case 'agent_session_operation_conflict':
    case 'agent_session_operation_expired':
    case 'agent_session_operation_invalid':
    case 'agent_session_identity_required':
      return [notDone]
    case 'agent_session_operation_unknown':
      return ['outcomeUnknown']
    // A Stop names the prompt it was pressed under, so it can be refused this way too.
    case 'agent_session_item_revision_stale':
    case 'agent_session_already_resolved':
      return causeParts('questionChanged', write)
    // A host that names no reason raised it for damage and for an open that can clear alike.
    case 'agent_session_journal_unreadable':
      return causeParts('historyUnreadable', write)
    case 'structured_agent_session_unsupported':
      return ['unsupported']
  }
  // A newer host can send a code this client has never heard of.
  return [notDone]
}

/** A send nobody can confirm: the host's own reason first when it gave one, never "not sent". */
export function agentSessionUnconfirmedSendParts(
  thrownRefusal: AgentSessionWriteFailure | null | undefined
): AgentSessionWriteNoticePart[] {
  const cause = thrownRefusal
    ? agentSessionWriteNoticeParts(thrownRefusal, 'composer-send').filter(
        (part) =>
          part !== 'notDoneSend' && part !== 'tryAgainComposerSend' && part !== 'outcomeUnknown'
      )
    : []
  return [...cause, 'sendOutcomeLost']
}

export function agentSessionWriteNoticeEnglish(
  parts: readonly AgentSessionWriteNoticePart[]
): string {
  return parts
    .map((part) =>
      typeof part === 'string'
        ? AGENT_SESSION_WRITE_NOTICE_COPY[part]
        : 'text' in part
          ? part.text
          : agentSessionFailureSentence(part.failure, part.surface, part.context)
    )
    .join(' ')
}

/** English, for a surface without translations. Takes the refusal as the wire gives it; its
 *  message is not read. */
export function agentSessionRefusalNotice(
  refusal: Pick<AgentSessionWireRefusal, 'code' | 'message' | 'details'>,
  write: AgentSessionWriteKind
): string {
  return agentSessionWriteNoticeEnglish(
    agentSessionWriteNoticeParts(agentSessionRefusalFailure(refusal), write)
  )
}

/** English, for a write whose request failed without a refusal. */
export function agentSessionWriteFailureNotice(write: AgentSessionWriteKind): string {
  return agentSessionWriteNoticeEnglish(agentSessionWriteNoticeParts({ kind: 'failed' }, write))
}

/** The notice for a refused read of a chat's history, from the refusal's code and any details a
 *  host sent; a code this build does not know says only that the history did not load. */
export function agentSessionReadHistoryRefusalParts(
  code: string,
  details?: unknown,
  context: AgentSessionFailureWordsContext = {}
): AgentSessionWriteNoticePart[] {
  const failure = parseAgentSessionWriteFailure({ kind: 'refused', code, details })
  return failure
    ? agentSessionWriteNoticeParts(failure, 'read-history', context)
    : agentSessionWriteNotDoneParts('read-history')
}
