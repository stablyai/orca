// Never show refusal.message: emitters use log prose/markers (test census). Choose by named reason, else code, naming causes only when all emitters agree.
// Keep facts until display so saved state contains no copy. Retry is the sending control, except phone sends return to its composer; retryable history opens name a retry unless the surface supplies one.

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
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

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
  'queued-edit': 'notDoneQueuedEdit',
  clear: 'notDoneCommand',
  compact: 'notDoneCommand',
  goal: 'notDoneGoalChangeIncomplete'
}

/** Share actionable wording for /clear and /compact blocked by running work. */
const COMMAND_WHILE_WORKING: Partial<
  Record<AgentSessionWriteKind, Partial<Record<string, AgentSessionWriteNoticeSentence[]>>>
> = {
  clear: {
    turnActive: ['agentStillWorking', 'runClearWhenDone'],
    messagesUnsettled: ['agentStillWorking', 'runClearWhenDone'],
    promptPending: ['clearAfterAnswer']
  },
  compact: {
    turnActive: ['agentStillWorking', 'runCompactWhenDone'],
    messagesUnsettled: ['agentStillWorking', 'runCompactWhenDone'],
    promptPending: ['compactAfterAnswer']
  }
}

/** For retryable writes, name how only on the phone, whose message returns to the composer; other surfaces retry with the sending control. */
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
    (cause === 'questionChanged' && write === 'answer') ||
    (cause === 'cancelNotSaved' && write === 'stop')
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
    (failure.details?.agentInstallation || failure.details?.codexInstallation) &&
    (write === 'send' || write === 'composer-send')
  ) {
    return [
      NOT_DONE[write],
      { failure: { kind: 'startFailed', refusal: failure }, surface: 'rejection', context }
    ]
  }
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
  const commandWhileWorking =
    failure.code === 'agent_session_operation_invalid'
      ? COMMAND_WHILE_WORKING[write]?.[failure.details?.reason ?? '']
      : undefined
  if (commandWhileWorking) {
    return commandWhileWorking
  }
  const words = agentSessionRefusalReasonWords(failure)
  if (!words || 'words' in words) {
    return undefined
  }
  if ('writes' in words) {
    if (!words.writes.includes(write)) {
      return undefined
    }
    const agent =
      failure.code === 'agent_session_operation_invalid' ? failure.details?.agent : undefined
    const said: AgentSessionWriteNoticePart[] = [
      {
        failure: { kind: words.fact },
        surface: 'row',
        context: agent ? { ...context, agentName: TUI_AGENT_DISPLAY_NAMES[agent] } : context
      }
    ]
    return context.retryControl && words.action === 'retry' ? said : [...said, words.step]
  }
  if ('fact' in words) {
    if (write === 'answer' && words.fact === 'providerExited') {
      // Name the ended agent and unsent answer, then give the next step.
      return [{ failure: { kind: words.fact }, surface: 'answer', context }]
    }
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

/** Cause for a failed start already showing Retry; empty without a reason carrying its own wording. */
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

/** retryControl replaces retry/send-again advice only; preserve any other next step. */
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
    // The status row holds the restart cause; this code cannot distinguish retryable cases from those needing a new chat.
    case 'agent_session_owner_restart_failed':
      return ['restartFailed', notDone]
    // Owner refusals precede recording the operation ID, so phone resends may succeed.
    case 'agent_session_checkpoint_stale':
    case 'agent_session_conflict':
    case 'agent_session_ownership_unknown':
    case 'execution_owner_reconciling':
      return agentSessionWriteNotDoneParts(write)
    // Only old hosts cap operation rows; updating fixes this, while immediate retries remain refused.
    case 'agent_session_operation_capacity':
      return [notDone, 'capacity']
    // Same-id phone resends stay refused; these codes span unnamed causes, so neither cause nor next step is safe to guess.
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

/** A message over the host's size bound, caught before it is sent: what to do instead of resending. */
export const AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS = [
  'notDoneSend',
  'messageTooLarge',
  'shortenMessage'
] as const satisfies readonly AgentSessionWriteNoticePart[]

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

/** English fallback for untranslated surfaces; never read the refusal message. */
export function agentSessionRefusalNotice(
  refusal: Pick<AgentSessionWireRefusal, 'code' | 'message' | 'details'>,
  write: AgentSessionWriteKind,
  context: AgentSessionFailureWordsContext = {}
): string {
  return agentSessionWriteNoticeEnglish(
    agentSessionWriteNoticeParts(agentSessionRefusalFailure(refusal), write, context)
  )
}

/** English, for a write whose request failed without a refusal. */
export function agentSessionWriteFailureNotice(write: AgentSessionWriteKind): string {
  return agentSessionWriteNoticeEnglish(agentSessionWriteNoticeParts({ kind: 'failed' }, write))
}

/** Word history-read refusals by code/details; unknown codes say only that history did not load. */
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
