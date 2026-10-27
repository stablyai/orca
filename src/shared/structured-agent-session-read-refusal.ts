import type { AgentSessionRefusalReference } from './agent-session-wire-refusals'

/** Unattached read refusal is transitional during attach/close (or quit on current hosts), not proof of unreadable history.
 * Latched ownership failures arrive through acquisition instead (agent-session-lease-adjudication). */

/** Raised by a host that holds no attached session by that id. */
export const AGENT_SESSION_UNATTACHED_REFUSAL_CODE = 'agent_session_ownership_unknown'

/** Attach/close usually settles within a second; report refusal beyond this grace rather than spin forever. */
export const AGENT_SESSION_UNATTACHED_READ_GRACE_MS = 5_000

/** Accept thrown RPC and raw stream-error shapes; both code/message can carry the bare refusal code. */
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

/** Stop reconnecting only for damaged/newer-format journals. Inspect refusal reason because every journal refusal shares a message code;
 * other open failures may clear and must keep retrying. */
export function isFinalAgentSessionReadRefusal(
  refusal: AgentSessionRefusalReference | undefined
): boolean {
  return (
    refusal?.code === 'agent_session_journal_unreadable' &&
    (refusal.details?.reason === 'journalCorrupt' ||
      refusal.details?.reason === 'journalWrittenByNewerOrca')
  )
}
