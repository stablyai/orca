// The message Orca sends when a user asks an interrupted agent to carry on.
//
// Identical for both providers, and deliberately not promptless. Codex's `turn/start`
// would accept an empty `input`, but Claude's SDK has no promptless form, so a bare continuation
// would make the two lanes behave differently — and the wording is the part that tells an agent to
// VERIFY its last action before repeating it. Both reasons point the same way.
//
// Sending this needs the user's OPT-IN, not their presence: the restart prompt's resume sends it,
// and so does a launch the user ticked "resume automatically" for. That is acceptable because the
// work being continued is the user's own, the wording above tells the agent to VERIFY its last
// action before repeating it, and the launch reports what it did. Reattaching without a send
// remains a separate operation that never comes here.

import type { AgentSessionResumeMarker } from './agent-session-resume-marker'

export const AGENT_SESSION_RESTART_CONTINUATION_MESSAGE =
  "Orca restarted, so your previous reply was cut off partway through. Before continuing, check whether your most recent action completed — don't repeat it if it did. Then carry on."

/** For a marker that may stand for more than a reply: subagents, background commands, monitors or
 *  a prompt the restart stopped. Names none of them — the provider restates what it lost on
 *  resume, and a body that varied with the journal would change between retries of one offer. */
export const AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE =
  "Orca restarted, which stopped what you were doing: a reply in progress, any subagents or background commands you had running, and any request waiting on the user. Before continuing, check what finished before the restart and don't repeat it. Restart anything still needed, ask again for anything still waiting on the user, then carry on."

/**
 * The continuation a marker gets. A function of the marker alone, because the payload fingerprint
 * covers the body and a retried offer must reach the ledger with the same one. A marker from a
 * build that recorded only a working lead keeps the original wording.
 */
export function restartContinuationMessage(
  marker: Pick<AgentSessionResumeMarker, 'activity'>
): string {
  return marker.activity
    ? AGENT_SESSION_RESTART_WORK_CONTINUATION_MESSAGE
    : AGENT_SESSION_RESTART_CONTINUATION_MESSAGE
}

/**
 * Host-authored journal note marking the send as Orca's rather than the user's.
 *
 * Attribution lives in the journal, not on the provider wire. Codex's `turn/start` has no parameter
 * we already send that could carry it, and adding one would be a new client-controlled field on a
 * path that deliberately allowlists its params — untestable against older app-servers and
 * Codex-only, which would break the both-providers symmetry above. The journal is ours, carries no
 * compatibility risk, behaves identically for both providers, and is queryable with the rest of the
 * session history.
 */
export const AGENT_SESSION_RESTART_CONTINUATION_NOTE =
  'Orca asked this agent to continue after a restart. Your own prompt was not re-sent.'

/** Host-authored notes left in a chat the continuation did not carry on, so the chat itself says
 *  what happened and what to do. The next message the user sends is the manual continuation. */
export const AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE =
  "Orca couldn't continue this chat after the restart. Send a message to continue it."
export const AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE =
  "Orca asked this agent to continue after the restart but couldn't confirm it did. Check its latest reply before sending another message."

/** For a chat Orca could not get hold of. Why decides the fix, which the restart list gives; advice
 *  to send a message would meet the same refusal. */
export const AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE =
  "Orca couldn't reconnect this chat after the restart, so it didn't ask the agent to continue."
