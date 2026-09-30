import type { AgentSessionRefusalReference } from './agent-session-wire-refusals'

/**
 * The one refusal a structured-session READ can raise that is not a failure to read.
 *
 * A current host opens a conversation for any read, so a read meets this code only once quit began.
 * An older host resolves `agentSession.history` and `agentSession.subscribe` against the sessions it
 * has attached, and raises it when it holds none by that id. Either way it is never a transcript
 * Orca could not read: an older host's session is not attached YET (the surface's hold attaches
 * one) or was just closed, and both windows end on their own.
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

/**
 * A read refusal no retry reads past: SQLite reported the chat's journal damaged. Decided from the
 * reason, never the message, which is the bare code for every journal refusal; a journal that
 * failed to open for any other reason can clear, so its read keeps reconnecting.
 */
export function isFinalAgentSessionReadRefusal(
  refusal: AgentSessionRefusalReference | undefined
): boolean {
  return (
    refusal?.code === 'agent_session_journal_unreadable' &&
    refusal.details?.reason === 'journalCorrupt'
  )
}
