// Use one explicit prompt for both providers: Claude lacks promptless resume, and the wording requires verifying the last action before repeating it.
// Chats send only after opt-in through Resume or resume-automatically, with a chat attribution note; a terminal gets one only under restart-all, which is its opt-in, and the text names Orca as sender. Reattach without sending remains separate.

import type { AgentSessionResumeMarker } from './agent-session-resume-marker'

export const AGENT_SESSION_RESTART_CONTINUATION_MESSAGE =
  "Orca restarted, so your previous reply was cut off partway through. Before continuing, check whether your most recent action completed — don't repeat it if it did. Then carry on."

/** For interrupted children/prompts too; name no activity because providers restate it and journal-dependent wording would change retry fingerprints. */
export const AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE =
  "Orca restarted. Resume the original unfinished user task with existing commitments and authorization. Check what's completed or still running before repeating actions. Recover needed interrupted work, re-ask only necessary unanswered questions, and continue until done or genuinely blocked."

export const AGENT_SESSION_ACCOUNT_SWITCH_CONTINUATION_MESSAGE =
  "Orca moved this chat to another account. Resume the original unfinished user task with existing commitments and authorization. Check what's completed or still running before repeating actions. Recover needed interrupted work, re-ask only necessary unanswered questions, and continue until done or genuinely blocked."

export const AGENT_SESSION_ACCOUNT_SWITCH_TERMINAL_CONTINUATION_MESSAGE =
  'Message from Orca, not typed by the user. Orca restarted this session on another account. If a task was in progress when the session stopped, check what is completed or still running, then carry on with it. If you were waiting for an answer from the user, or the user had stopped you, do not continue the work. Restate where things stand and wait. If nothing is unfinished, say so in one line.'

export type AgentSessionContinuationSource = Pick<AgentSessionResumeMarker, 'activity'> & {
  accountSwitch?: true
}

/** Derive only from the marker to keep retry fingerprints stable; legacy working-lead markers retain original wording. */
export function restartContinuationMessage(marker: AgentSessionContinuationSource): string {
  if (marker.accountSwitch) {
    return AGENT_SESSION_ACCOUNT_SWITCH_CONTINUATION_MESSAGE
  }
  return marker.activity
    ? AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE
    : AGENT_SESSION_RESTART_CONTINUATION_MESSAGE
}

/** Attribute the send in our journal, not provider params: Codex allowlists them, older servers cannot be verified, and a Codex-only field would break provider parity. */
export const AGENT_SESSION_RESTART_CONTINUATION_NOTE =
  'Orca asked this agent to continue after a restart. Your own prompt was not re-sent.'
export const AGENT_SESSION_ACCOUNT_SWITCH_CONTINUATION_NOTE =
  'Orca asked this agent to continue after an account switch. Your own prompt was not re-sent.'

/** Record what prevented continuation and the next step; the user's next message continues manually. */
export const AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE =
  "Orca couldn't continue this chat after the restart. Send a message to continue it."
export const AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE =
  "Orca asked this agent to continue after the restart but couldn't confirm it did. Check its latest reply before sending another message."
export const AGENT_SESSION_ACCOUNT_SWITCH_CONTINUATION_REFUSED_NOTE =
  "Orca couldn't continue this chat after the account switch. Send a message to continue it."
export const AGENT_SESSION_ACCOUNT_SWITCH_CONTINUATION_UNCONFIRMED_NOTE =
  "Orca asked this agent to continue after the account switch but couldn't confirm it did. Check its latest reply before sending another message."

/** For unreachable chats, the restart list names the repair; advising a send would repeat the refusal. */
export const AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE =
  "Orca couldn't reconnect this chat after the restart, so it didn't ask the agent to continue."
export const AGENT_SESSION_ACCOUNT_SWITCH_NOT_CONNECTED_NOTE =
  "Orca couldn't reconnect this chat after the account switch, so it didn't ask the agent to continue."

export type AgentSessionContinuationNoteOutcome =
  | 'continued'
  | 'refused'
  | 'unconfirmed'
  | 'not-connected'

const CONTINUATION_NOTES = {
  restart: {
    continued: AGENT_SESSION_RESTART_CONTINUATION_NOTE,
    refused: AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
    unconfirmed: AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
    'not-connected': AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE
  },
  accountSwitch: {
    continued: AGENT_SESSION_ACCOUNT_SWITCH_CONTINUATION_NOTE,
    refused: AGENT_SESSION_ACCOUNT_SWITCH_CONTINUATION_REFUSED_NOTE,
    unconfirmed: AGENT_SESSION_ACCOUNT_SWITCH_CONTINUATION_UNCONFIRMED_NOTE,
    'not-connected': AGENT_SESSION_ACCOUNT_SWITCH_NOT_CONNECTED_NOTE
  }
} as const

export function restartContinuationNote(
  marker: AgentSessionContinuationSource,
  outcome: AgentSessionContinuationNoteOutcome
): string {
  return CONTINUATION_NOTES[marker.accountSwitch ? 'accountSwitch' : 'restart'][outcome]
}
