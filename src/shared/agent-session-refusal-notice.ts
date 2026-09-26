// The one way a chat surface puts a refused `agentSession.*` write into words.
//
// A refusal's `message` is written for whoever debugs the host ("Expected runtime fence 1; the
// session is at 3."), so it is never shown. The code says what happened and the write says what
// the person can do next; together they pick the copy.

import type { AgentSessionWireRefusal } from './agent-session-wire-refusals'

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

const TRY_AGAIN: Record<AgentSessionWriteKind, string> = {
  send: 'Retry to send it again.',
  'composer-send': 'Send it again.',
  stop: 'Press Stop again.',
  answer: 'Answer it again.',
  option: 'Choose it again.',
  command: 'Run the command again.',
  goal: 'Set the goal again.'
}

const NOT_DONE: Record<AgentSessionWriteKind, string> = {
  send: 'Your message was not sent.',
  'composer-send': 'Your message was not sent.',
  stop: "The agent wasn't stopped.",
  answer: 'Your answer was not sent.',
  option: "The setting wasn't changed.",
  command: "The command didn't run.",
  goal: "The goal wasn't changed."
}

export function agentSessionRefusalNotice(
  refusal: Pick<AgentSessionWireRefusal, 'code' | 'message'>,
  write: AgentSessionWriteKind
): string {
  const notDone = NOT_DONE[write]
  const tryAgain = TRY_AGAIN[write]
  switch (refusal.code) {
    // The one refusal the host words for people, next step included: the agent's start failure.
    case 'agent_session_owner_restart_failed':
      return refusal.message.trim() || `${notDone} ${tryAgain}`
    case 'agent_session_checkpoint_stale':
    case 'agent_session_conflict':
    case 'agent_session_ownership_unknown':
    case 'execution_owner_reconciling':
      return `The agent was restarting. ${notDone} ${tryAgain}`
    case 'agent_session_operation_capacity':
      return `Orca is handling too many requests for this chat. ${notDone} ${tryAgain}`
    case 'agent_session_operation_conflict':
    case 'agent_session_operation_expired':
      return `${notDone} ${tryAgain}`
    case 'agent_session_operation_invalid':
      return write === 'command'
        ? `${notDone} Wait for the agent to finish, then run it again.`
        : `${notDone} ${tryAgain}`
    case 'agent_session_operation_unknown':
      return "Orca couldn't confirm whether that went through. Check the chat before trying again."
    case 'agent_session_item_revision_stale':
    case 'agent_session_already_resolved':
      return 'This question was already answered or has changed.'
    case 'agent_session_identity_required':
      return `Orca couldn't find this chat's agent session. ${notDone} ${tryAgain}`
    case 'agent_session_journal_unreadable':
      return `Orca couldn't read this chat's saved history. ${notDone} ${tryAgain}`
    case 'structured_agent_session_unsupported':
      return "The Orca running this chat doesn't support this. Update Orca, then try again."
  }
  // A newer host can send a code this client has never heard of.
  return `${notDone} ${tryAgain}`
}

/** For a write whose request failed without a refusal, so nothing is claimed about whether it ran. */
export function agentSessionWriteFailureNotice(write: AgentSessionWriteKind): string {
  return `Orca couldn't reach the agent. ${TRY_AGAIN[write]}`
}
