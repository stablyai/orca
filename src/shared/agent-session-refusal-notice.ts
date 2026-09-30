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

import type { AgentSessionFailureKind } from './agent-session-failure'
import {
  agentSessionFailureSentence,
  type AgentSessionFailureWordsContext
} from './agent-session-failure-words'
import type { AgentSessionRefusalReason } from './agent-session-refusal-details'
import {
  AGENT_SESSION_WRITE_NOTICE_COPY,
  type AgentSessionWriteNoticePart,
  type AgentSessionWriteNoticeSentence
} from './agent-session-write-notice-copy'
import type {
  AgentSessionWireRefusal,
  AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'
import {
  agentSessionRefusalFailure,
  parseAgentSessionWriteFailure,
  type AgentSessionWriteFailure,
  type AgentSessionWriteKind,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'

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

/** What the person can do about a refusal with this reason. */
export type AgentSessionRefusalAction =
  /** Use the control that sent the write again. */
  | 'retry'
  /** Wait for what the notice names; its step says what. */
  | 'wait'
  /** Take the step the notice names first. */
  | 'actFirst'
  /** Continue somewhere else: the current conversation, or a new chat. */
  | 'goElsewhere'
  | 'checkChat'
  | 'updateOrca'
  /** What the write was for is over: the question it answered moved on. */
  | 'nothingLeft'
  /** Orca's own state or fault; nothing the person does gets past it. */
  | 'hostFinding'

export type AgentSessionRefusalReasonWords =
  /** The code's own words are the honest ones for this reason. */
  | { words: 'code'; action: AgentSessionRefusalAction }
  /** What stopped the write, and the step past it where the person has one to take. */
  | {
      cause: AgentSessionWriteNoticeSentence
      step?: AgentSessionWriteNoticeSentence
      action: AgentSessionRefusalAction
    }
  /** A start that failed: the sentence that failure has everywhere, whose next step is a send. */
  | { fact: AgentSessionFailureKind; action: AgentSessionRefusalAction }

function codeWords(action: AgentSessionRefusalAction): AgentSessionRefusalReasonWords {
  return { words: 'code', action }
}

function causeWords(
  cause: AgentSessionWriteNoticeSentence,
  action: AgentSessionRefusalAction,
  step?: AgentSessionWriteNoticeSentence
): AgentSessionRefusalReasonWords {
  return step ? { cause, step, action } : { cause, action }
}

const AGENT_STARTING = causeWords('agentStarting', 'wait', 'waitForStart')
const OWNER_UNPROVEN = causeWords('ownerUnproven', 'actFirst', 'reopenChat')
// Only a terminal agent an older build recorded holds a claim; quitting it frees the chat.
const TERMINAL_CLAIM = causeWords('terminalAgentHoldsChat', 'actFirst', 'quitTerminalAgent')

// Every reason of every code, so a reason the host adds does not compile until it has words.
// Reasons only a create, attach, hold or adopted import meets never reach a chat write; they keep
// their code's words.
const REASON_WORDS = {
  agent_session_operation_invalid: {
    requestMalformed: codeWords('hostFinding'),
    operationIdInvalid: codeWords('hostFinding'),
    messageIdReused: codeWords('hostFinding'),
    // Settled under that id, so the control's retry goes out under a new one.
    operationRefusedEarlier: codeWords('retry'),
    journalWriteFailed: causeWords('recordFailed', 'retry'),
    conversationCleared: causeWords(
      'conversationCleared',
      'goElsewhere',
      'openCurrentConversation'
    ),
    // Only an older host sends this, and it keeps refusing the chat, so only a new chat continues.
    clearUnconfirmed: causeWords('clearUnfinished', 'goElsewhere', 'startNewChat'),
    // Only an older host sends this, for a /clear it never settled; only that host resolves it.
    conversationCommandUnconfirmed: codeWords('hostFinding'),
    conversationCommandInFlight: causeWords('commandRunning', 'wait', 'waitForCommand'),
    // The chat's agent process is being replaced, which a start or restart does.
    handoffInFlight: AGENT_STARTING,
    turnActive: causeWords('turnActive', 'wait', 'waitForTurn'),
    promptPending: causeWords('promptPending', 'actFirst', 'answerFirst'),
    backgroundTasksRunning: causeWords('backgroundTasksRunning', 'wait', 'waitForBackgroundTasks'),
    messagesUnsettled: causeWords('messagesUnsettled', 'actFirst', 'settleEarlierMessage'),
    // No chat surface sends a rewind; a replayed one says only that it did not happen.
    rewindRefused: codeWords('hostFinding'),
    rewindUnconfirmed: codeWords('hostFinding'),
    promptGone: causeWords('questionChanged', 'nothingLeft'),
    optionRejected: causeWords('optionRejected', 'retry'),
    providerStarting: AGENT_STARTING,
    goalsUnsupported: causeWords('goalsUnsupported', 'hostFinding'),
    providerRejected: causeWords('agentRefused', 'retry'),
    providerStartFailed: { fact: 'providerStartFailed', action: 'retry' },
    notSignedIn: { fact: 'notSignedIn', action: 'actFirst' },
    historyTooLarge: { fact: 'historyTooLarge', action: 'goElsewhere' },
    managedAccountEnvOverride: { fact: 'managedAccountEnvOverride', action: 'actFirst' },
    accountSwitchInProgress: { fact: 'accountSwitchInProgress', action: 'wait' },
    managedAccountUnsupported: { fact: 'managedAccountUnsupported', action: 'actFirst' },
    attachFailed: codeWords('retry')
  },
  agent_session_ownership_unknown: {
    sessionNotAttached: codeWords('retry'),
    noLiveOwner: codeWords('retry'),
    ownerUnproven: OWNER_UNPROVEN,
    claimConflicted: TERMINAL_CLAIM,
    recordMissing: codeWords('retry'),
    replaySuperseded: codeWords('retry'),
    leaseMoved: codeWords('retry'),
    spawnIdentityMismatch: codeWords('hostFinding'),
    notResumable: codeWords('retry'),
    noProviderChild: codeWords('retry'),
    conversationHeldElsewhere: codeWords('retry')
  },
  agent_session_conflict: {
    chatStarting: AGENT_STARTING,
    ownerUnproven: OWNER_UNPROVEN,
    claimConflicted: TERMINAL_CLAIM,
    ownerAlive: codeWords('retry'),
    identityMismatch: codeWords('hostFinding'),
    sessionExists: codeWords('retry'),
    conversationHeldElsewhere: codeWords('retry'),
    tabIdTaken: codeWords('retry')
  },
  execution_owner_reconciling: {
    hostReconciling: causeWords('hostReconciling', 'wait', 'waitMoment'),
    recordUnreadable: causeWords('recordUnreadable', 'hostFinding')
  },
  agent_session_checkpoint_stale: {
    fenceStale: codeWords('retry'),
    leaseMoved: codeWords('retry'),
    recordMissing: codeWords('retry')
  },
  agent_session_identity_required: {
    recordMissing: causeWords('chatNotFound', 'goElsewhere', 'startNewChat'),
    transcriptNotFound: codeWords('retry'),
    transcriptUnreadable: codeWords('hostFinding')
  },
  agent_session_operation_conflict: {
    fingerprintMismatch: codeWords('hostFinding'),
    operationIdReused: codeWords('hostFinding'),
    handoffInFlight: codeWords('retry')
  },
  agent_session_operation_expired: { operationExpired: codeWords('retry') },
  agent_session_operation_capacity: { operationCapacity: codeWords('wait') },
  agent_session_operation_unknown: {
    outcomeUnknown: codeWords('checkChat'),
    resultLost: codeWords('checkChat'),
    rewindUnconfirmed: codeWords('checkChat'),
    tabUnconfirmed: codeWords('checkChat')
  },
  agent_session_item_revision_stale: { promptMoved: codeWords('nothingLeft') },
  agent_session_already_resolved: { promptAlreadyResolved: codeWords('nothingLeft') },
  agent_session_journal_unreadable: {
    // No retry reads past damage, and the words name no step: it only can't load.
    journalCorrupt: causeWords('historyUnusable', 'hostFinding'),
    // Says its step despite 'retry' unless a Retry stands beside it: the phone often has none.
    journalUnavailable: causeWords('historyUnavailable', 'retry', 'tryAgain'),
    journalWrittenByNewerOrca: causeWords('savedByNewerOrca', 'updateOrca', 'updateOrcaToKeepUsing')
  },
  // Thrown, so a client meets these only as an RPC error; the code's words stand.
  structured_agent_session_unsupported: {
    clientCapabilityMissing: codeWords('updateOrca'),
    hostDisabled: codeWords('hostFinding'),
    hostUnsupported: codeWords('updateOrca')
  },
  agent_session_owner_restart_failed: {}
} satisfies {
  [C in AgentSessionWireRefusalCode]: Record<
    AgentSessionRefusalReason<C>,
    AgentSessionRefusalReasonWords
  >
}

/** The words and next step a reason gets; undefined when the refusal names none. */
export function agentSessionRefusalReasonWords(
  failure: AgentSessionWriteRefusal
): AgentSessionRefusalReasonWords | undefined {
  const reason = failure.details?.reason
  const byReason: Partial<Record<string, AgentSessionRefusalReasonWords>> | undefined =
    REASON_WORDS[failure.code]
  return reason === undefined ? undefined : byReason?.[reason]
}

// Each already says the history can't be read here.
const HISTORY_CAUSES: ReadonlySet<AgentSessionWriteNoticeSentence> = new Set([
  'historyUnusable',
  'historyUnavailable',
  'historyUnreadable',
  'savedByNewerOrca'
])

/** A cause, and that the request did not happen unless the cause already says so. */
function causeParts(
  cause: AgentSessionWriteNoticeSentence,
  write: AgentSessionWriteKind
): AgentSessionWriteNoticeSentence[] {
  const saysNotDone =
    (write === 'read-history' && HISTORY_CAUSES.has(cause)) ||
    (cause === 'questionChanged' && write === 'answer')
  return saysNotDone ? [cause] : [cause, NOT_DONE[write]]
}

/** The notice a named reason has of its own; undefined leaves the code's words. */
function reasonParts(
  failure: AgentSessionWriteRefusal,
  write: AgentSessionWriteKind,
  context: AgentSessionFailureWordsContext
): AgentSessionWriteNoticePart[] | undefined {
  const words = agentSessionRefusalReasonWords(failure)
  if (!words || 'words' in words) {
    return undefined
  }
  if ('fact' in words) {
    const sentence = agentSessionFailureSentence({ kind: words.fact }, 'rejection', context)
    return write === 'send' || write === 'composer-send'
      ? [NOT_DONE[write], { text: sentence }]
      : undefined
  }
  const said = causeParts(words.cause, write)
  // A Retry beside the words is the step for a reason whose action is to retry.
  const retried = context.retryControl && words.action === 'retry'
  return words.step && !retried ? [...said, words.step] : said
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

export function agentSessionWriteNoticeEnglish(
  parts: readonly AgentSessionWriteNoticePart[]
): string {
  return parts
    .map((part) => (typeof part === 'string' ? AGENT_SESSION_WRITE_NOTICE_COPY[part] : part.text))
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
