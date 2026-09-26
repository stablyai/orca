// The one way a chat surface puts a write that did not happen into words.
//
// A refusal's `message` is never shown. Every code has at least one host emitter whose message is
// written for a log or carries a marker (the census is pinned in the test), so the code and the
// write pick the copy. A cause is named only where every emitter of the code means it. No notice
// says how to try again: the control that sent the write does that, except on the phone, whose
// message goes back to the composer. Surfaces keep the fact and choose the words when they show
// it, so nothing saved carries copy.

import {
  isAgentSessionWireRefusalCode,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'

/** What the person was doing, which decides what the notice says did not happen. `send` keeps
 *  the message behind a Retry control; `composer-send` puts it back in the composer, as the phone
 *  does. */
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

/** Why a write did not happen, or that nothing proves it did not. */
export type AgentSessionWriteFailure =
  | { kind: 'refused'; code: AgentSessionWireRefusalCode }
  /** The request failed without a refusal before the host ran it, so nothing is known about why. */
  | { kind: 'failed' }
  /** The request failed where the host may already have run it (a timeout, a lost connection, an
   *  error inside the method). */
  | { kind: 'unconfirmed' }

export function agentSessionRefusalFailure(
  refusal: Pick<AgentSessionWireRefusal, 'code'>
): AgentSessionWriteFailure {
  return { kind: 'refused', code: refusal.code }
}

/** A request that threw, from the RPC error code the host answered with (undefined when none came
 *  back). Only a host that turned it away before running the method proves the write did not
 *  happen. */
export function agentSessionRpcErrorFailure(code: string | undefined): AgentSessionWriteFailure {
  if (code === 'method_not_found' || code === 'method_not_supported') {
    return { kind: 'refused', code: 'structured_agent_session_unsupported' }
  }
  return code === 'invalid_argument' || code === 'unauthorized'
    ? { kind: 'refused', code: 'agent_session_operation_invalid' }
    : { kind: 'unconfirmed' }
}

/** A saved failure, or undefined when it is not one this build wrote. */
export function parseAgentSessionWriteFailure(
  value: unknown
): AgentSessionWriteFailure | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return undefined
  }
  if (value.kind === 'failed') {
    return { kind: 'failed' }
  }
  return value.kind === 'refused' && 'code' in value && isAgentSessionWireRefusalCode(value.code)
    ? { kind: 'refused', code: value.code }
    : undefined
}

/** Every sentence a notice is made of. Desktop translates each whole sentence with this as its
 *  fallback; mobile shows it as is. */
export const AGENT_SESSION_WRITE_NOTICE_COPY = {
  notDoneSend: 'Your message was not sent.',
  tryAgainComposerSend: 'Send it again.',
  notDoneStop: "The agent wasn't stopped.",
  notDoneAnswer: 'Your answer was not sent.',
  notDoneOption: "The setting wasn't changed.",
  notDoneCommand: "The command didn't run.",
  notDoneGoal: "The goal wasn't changed.",
  restartFailed: "The agent couldn't restart.",
  capacity: 'Orca has received too many requests in the last day.',
  outcomeUnknown: "Orca couldn't confirm what happened. Check the chat.",
  questionChanged: 'This question was already answered or has changed.',
  historyUnreadable: "Orca couldn't read this chat's saved history.",
  unsupported: "The Orca running this chat doesn't support this. Update Orca, then try again.",
  unreachable: "Orca couldn't reach the agent."
} as const

export type AgentSessionWriteNoticeSentence = keyof typeof AGENT_SESSION_WRITE_NOTICE_COPY
/** A notice as whole sentences, each translated on its own; `text` is a provider's own words. */
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

/** That the write did not happen, for one that a second attempt can carry out. Only the phone says
 *  how: its message goes back to the composer and it has no Retry control. Everywhere else the
 *  control that sent the write is the way to try again. */
export function agentSessionWriteNotDoneParts(
  write: AgentSessionWriteKind
): AgentSessionWriteNoticeSentence[] {
  return write === 'composer-send' ? ['notDoneSend', 'tryAgainComposerSend'] : [NOT_DONE[write]]
}

export function agentSessionWriteNoticeParts(
  failure: AgentSessionWriteFailure,
  write: AgentSessionWriteKind
): AgentSessionWriteNoticePart[] {
  const notDone = NOT_DONE[write]
  if (failure.kind === 'failed') {
    return agentSessionWriteNotDoneParts(write)
  }
  if (failure.kind === 'unconfirmed') {
    return ['outcomeUnknown']
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
    case 'agent_session_item_revision_stale':
    case 'agent_session_already_resolved':
      return ['questionChanged']
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

/** English, for a surface without translations. Takes the refusal as the wire gives it; its
 *  message is not read. */
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
  return agentSessionWriteNoticeEnglish(agentSessionWriteNoticeParts({ kind: 'failed' }, write))
}
