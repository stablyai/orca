// The one way a chat surface puts a write that did not happen into words.
//
// A refusal's `message` is written for whoever debugs the host ("Expected runtime fence 1; the
// session is at 3."), so it is never shown. The code says what happened and the write says what
// the person can do next; together they pick the copy. Surfaces keep the fact and choose the words
// when they show it, so nothing saved carries copy.

import {
  isAgentSessionWireRefusalCode,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'

/** What the person was doing, which decides how they try again. `send` keeps the message
 *  behind a Retry control; `composer-send` puts it back in the composer, as the phone does. */
export type AgentSessionWriteKind =
  | 'send'
  | 'composer-send'
  | 'stop'
  | 'answer'
  | 'option'
  | 'command'
  | 'goal'

/** The kind of write an `agentSession.*` fingerprint method stands for. */
export function agentSessionWriteKindForMethod(fingerprintMethod: string): AgentSessionWriteKind {
  if (fingerprintMethod === 'agentSession.send') {
    return 'send'
  }
  if (fingerprintMethod === 'agentSession.cancel') {
    return 'stop'
  }
  if (fingerprintMethod.startsWith('agentSession.respondTo')) {
    return 'answer'
  }
  if (fingerprintMethod === 'agentSession.setOption') {
    return 'option'
  }
  if (fingerprintMethod === 'agentSession.threadGoal') {
    return 'goal'
  }
  return 'command'
}

/** Why a write did not happen. The host's message is kept only for the one code the host words
 *  for people. */
export type AgentSessionWriteFailure =
  | { kind: 'refused'; code: AgentSessionWireRefusalCode; hostMessage?: string }
  /** The request failed without a refusal, so nothing is known about the host's view of it. */
  | { kind: 'unreachable' }

export function agentSessionRefusalFailure(
  refusal: Pick<AgentSessionWireRefusal, 'code' | 'message'>
): AgentSessionWriteFailure {
  const hostMessage =
    refusal.code === 'agent_session_owner_restart_failed' ? refusal.message.trim() : ''
  return hostMessage
    ? { kind: 'refused', code: refusal.code, hostMessage }
    : { kind: 'refused', code: refusal.code }
}

/** A saved failure, or undefined when it is not one this build wrote. */
export function parseAgentSessionWriteFailure(
  value: unknown
): AgentSessionWriteFailure | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return undefined
  }
  if (value.kind === 'unreachable') {
    return { kind: 'unreachable' }
  }
  if (
    value.kind !== 'refused' ||
    !('code' in value) ||
    !isAgentSessionWireRefusalCode(value.code)
  ) {
    return undefined
  }
  const hostMessage = 'hostMessage' in value ? value.hostMessage : ''
  return typeof hostMessage === 'string'
    ? agentSessionRefusalFailure({ code: value.code, message: hostMessage })
    : undefined
}

/** Every sentence a notice is made of. Desktop translates each whole sentence with this as its
 *  fallback; mobile shows it as is. */
export const AGENT_SESSION_WRITE_NOTICE_COPY = {
  notDoneSend: 'Your message was not sent.',
  tryAgainSend: 'Retry to send it again.',
  tryAgainComposerSend: 'Send it again.',
  notDoneStop: "The agent wasn't stopped.",
  tryAgainStop: 'Press Stop again.',
  notDoneAnswer: 'Your answer was not sent.',
  tryAgainAnswer: 'Answer it again.',
  notDoneOption: "The setting wasn't changed.",
  tryAgainOption: 'Choose it again.',
  notDoneCommand: "The command didn't run.",
  tryAgainCommand: 'Run the command again.',
  notDoneGoal: "The goal wasn't changed.",
  tryAgainGoal: 'Set the goal again.',
  ownerUnconfirmed: "Orca couldn't confirm which agent process owns this chat.",
  capacity: 'Orca is handling too many requests for this chat.',
  outcomeUnknown:
    "Orca couldn't confirm whether that went through. Check the chat before trying again.",
  questionChanged: 'This question was already answered or has changed.',
  sessionMissing: "Orca couldn't find this chat's agent session.",
  historyUnreadable: "Orca couldn't read this chat's saved history.",
  unsupported: "The Orca running this chat doesn't support this. Update Orca, then try again.",
  unreachable: "Orca couldn't reach the agent.",
  messageNotSent: 'Message was not sent.',
  rejectedUnreachable:
    "Couldn't reach the agent. Your message was not sent — Retry to send it again.",
  rejectedInternal: 'Orca could not send your message — Retry to send it again.'
} as const

export type AgentSessionWriteNoticeSentence = keyof typeof AGENT_SESSION_WRITE_NOTICE_COPY
/** A notice as whole sentences, each translated on its own; `text` is shown in its author's words. */
export type AgentSessionWriteNoticePart = AgentSessionWriteNoticeSentence | { text: string }

const NOT_DONE: Record<AgentSessionWriteKind, AgentSessionWriteNoticeSentence> = {
  send: 'notDoneSend',
  'composer-send': 'notDoneSend',
  stop: 'notDoneStop',
  answer: 'notDoneAnswer',
  option: 'notDoneOption',
  command: 'notDoneCommand',
  goal: 'notDoneGoal'
}

const TRY_AGAIN: Record<AgentSessionWriteKind, AgentSessionWriteNoticeSentence> = {
  send: 'tryAgainSend',
  'composer-send': 'tryAgainComposerSend',
  stop: 'tryAgainStop',
  answer: 'tryAgainAnswer',
  option: 'tryAgainOption',
  command: 'tryAgainCommand',
  goal: 'tryAgainGoal'
}

export function agentSessionWriteNoticeParts(
  failure: AgentSessionWriteFailure,
  write: AgentSessionWriteKind
): AgentSessionWriteNoticePart[] {
  const notDone = NOT_DONE[write]
  const tryAgain = TRY_AGAIN[write]
  if (failure.kind === 'unreachable') {
    return ['unreachable', tryAgain]
  }
  switch (failure.code) {
    // The one refusal the host words for people, next step included: the agent's start failure.
    case 'agent_session_owner_restart_failed':
      return failure.hostMessage ? [{ text: failure.hostMessage }] : [notDone, tryAgain]
    case 'agent_session_checkpoint_stale':
    case 'agent_session_conflict':
    case 'agent_session_ownership_unknown':
    case 'execution_owner_reconciling':
      return ['ownerUnconfirmed', notDone, tryAgain]
    case 'agent_session_operation_capacity':
      return ['capacity', notDone, tryAgain]
    case 'agent_session_operation_conflict':
    case 'agent_session_operation_expired':
      return [notDone, tryAgain]
    // Refused for a reason the code does not name (a cleared conversation, a pending question, a
    // provider's own rejection...), so any next step could be false.
    case 'agent_session_operation_invalid':
      return [notDone]
    case 'agent_session_operation_unknown':
      return ['outcomeUnknown']
    case 'agent_session_item_revision_stale':
    case 'agent_session_already_resolved':
      return ['questionChanged']
    case 'agent_session_identity_required':
      return ['sessionMissing', notDone]
    case 'agent_session_journal_unreadable':
      return ['historyUnreadable', notDone]
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

/** English, for a surface without translations. */
export function agentSessionRefusalNotice(
  refusal: Pick<AgentSessionWireRefusal, 'code' | 'message'>,
  write: AgentSessionWriteKind
): string {
  return agentSessionWriteNoticeEnglish(
    agentSessionWriteNoticeParts(agentSessionRefusalFailure(refusal), write)
  )
}

/** English, for a write whose request failed without a refusal. */
export function agentSessionWriteFailureNotice(write: AgentSessionWriteKind): string {
  return agentSessionWriteNoticeEnglish(
    agentSessionWriteNoticeParts({ kind: 'unreachable' }, write)
  )
}
