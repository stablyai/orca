// Use one explicit prompt for both providers: Claude lacks promptless resume, and the wording requires verifying the last action before repeating it.
// Send only after opt-in through Resume or resume-automatically, with a chat attribution note. Reattach without sending remains separate.

import type { AgentSessionResumeMarker } from './agent-session-resume-marker'

export const AGENT_SESSION_RESTART_CONTINUATION_MESSAGE =
  "Orca restarted, so your previous reply was cut off partway through. Before continuing, check whether your most recent action completed — don't repeat it if it did. Then carry on."

/** For interrupted children/prompts too; name no activity because providers restate it and journal-dependent wording would change retry fingerprints. */
export const AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE =
  "Orca restarted, which stopped what you were doing: a reply in progress, any subagents or background commands you had running, and any request waiting on the user. Before continuing, check what finished before the restart and don't repeat it. Restart anything still needed, ask again for anything still waiting on the user, then carry on."

/** Derive only from the marker to keep retry fingerprints stable; legacy working-lead markers retain original wording. */
export function restartContinuationMessage(
  marker: Pick<AgentSessionResumeMarker, 'activity'>
): string {
  return marker.activity
    ? AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE
    : AGENT_SESSION_RESTART_CONTINUATION_MESSAGE
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
