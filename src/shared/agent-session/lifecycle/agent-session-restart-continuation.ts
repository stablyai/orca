// Use one explicit prompt for both providers: Claude lacks promptless resume, and the wording requires verifying the last action before repeating it.
// Send only after opt-in through Resume or resume-automatically, with a chat attribution note. Reattach without sending remains separate.

import type { AgentSessionResumeMarker } from './agent-session-resume-marker'

export const AGENT_SESSION_RESTART_CONTINUATION_MESSAGE =
  "Orca restarted. Check what's completed or still running before repeating actions, then recover unfinished work within the existing authorization. Any question or approval still pending in Orca remains open; its answer will arrive as a new user message. Check the chat's current requests before asking: do not re-ask a saved pending request, infer its answer, or perform work that requires it. Continue independent authorized background work. Ask a necessary question only when no corresponding saved pending request remains."

export const AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE =
  AGENT_SESSION_RESTART_CONTINUATION_MESSAGE

/** Current request state is read separately; accepted attempts replay their original saved body. */
export function restartContinuationMessage(
  _marker: Pick<AgentSessionResumeMarker, 'activity'>
): string {
  return AGENT_SESSION_RESTART_CONTINUATION_MESSAGE
}

/** Attribute the send in our journal, not provider params: Codex allowlists them, older servers cannot be verified, and a Codex-only field would break provider parity. */
export const AGENT_SESSION_RESTART_CONTINUATION_NOTE =
  'Orca asked this agent to continue after a restart. Your own prompt was not re-sent.'

/** Record what prevented continuation and the next step; the user's next message continues manually. */
export const AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE =
  "Orca couldn't continue this chat after the restart. Send a message to continue it."
export const AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE =
  "Orca asked this agent to continue after the restart but couldn't confirm it did. Check its latest reply before sending another message."

/** For unreachable chats, the restart list names the repair; advising a send would repeat the refusal. */
export const AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE =
  "Orca couldn't reconnect this chat after the restart, so it didn't ask the agent to continue."
