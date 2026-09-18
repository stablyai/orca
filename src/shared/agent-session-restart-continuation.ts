// The one message Orca sends when a user asks an interrupted agent to carry on.
//
// ONE constant, identical for both providers, and deliberately not promptless. Codex's `turn/start`
// would accept an empty `input`, but Claude's SDK has no promptless form, so a bare continuation
// would make the two lanes behave differently — and the wording is the part that tells an agent to
// VERIFY its last action before repeating it. Both reasons point the same way.
//
// Sending this is ALWAYS a deliberate user action. Reconnecting never sends it, and the automatic
// path never reaches this module: see `structured-agent-session-restart-resume-host`, where the
// resume surface contains no send at all.

export const AGENT_SESSION_RESTART_CONTINUATION_MESSAGE =
  "Orca restarted, so your previous reply was cut off partway through. Before continuing, check whether your most recent action completed — don't repeat it if it did. Then carry on."

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
