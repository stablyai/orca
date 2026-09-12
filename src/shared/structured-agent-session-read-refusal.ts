/**
 * The one refusal a structured-session READ can raise that is not a failure to read.
 *
 * `agentSession.history` and `agentSession.subscribe` both resolve the session through the host's
 * `requireSession`, which raises this code when the host holds no session object by that id. That
 * is never a transcript Orca could not read — it is a session this host has not attached YET (the
 * surface's hold is what attaches one) or one it has just closed. Both windows end on their own:
 * the first when the hold lands, the second when the chat tab retires.
 *
 * The genuinely latched lease — "Orca cannot prove the previous owner exited" — reaches the client
 * through the ACQUISITION path instead, so narrowing on the code costs a read no real diagnosis.
 * See `agent-session-lease-adjudication`.
 */

/** Raised by a host that holds no attached session by that id. */
export const AGENT_SESSION_UNATTACHED_REFUSAL_CODE = 'agent_session_ownership_unknown'

/**
 * How long a read may keep refusing this way before the pane is allowed to call it a failure.
 *
 * Both windows this code covers are sub-second in practice, so an unattached read that outlives
 * this one is no longer transitional and the user is owed the error rather than a spinner that
 * never resolves.
 */
export const AGENT_SESSION_UNATTACHED_READ_GRACE_MS = 5_000

/**
 * Whether a read failure is that refusal.
 *
 * Takes both shapes the client sees: the thrown RPC error, whose `code` and `message` are each the
 * bare refusal code, and the raw failure payload a stream delivers to its error callback.
 */
export function isUnattachedAgentSessionReadRefusal(error: unknown): boolean {
  if (typeof error === 'string') {
    return error === AGENT_SESSION_UNATTACHED_REFUSAL_CODE
  }
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const { code, message } = error as { code?: unknown; message?: unknown }
  return (
    code === AGENT_SESSION_UNATTACHED_REFUSAL_CODE ||
    message === AGENT_SESSION_UNATTACHED_REFUSAL_CODE
  )
}
