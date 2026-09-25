import { isAgentSessionId } from './agent-session-record'

/**
 * The Orca session id is the id Orca minted for a structured session (its session record id), never
 * the provider's own session id. Orchestration stores, bare, the one the agent is addressed by: for
 * a `/clear`ed chat, its lineage root's, not the live session's. Mail addresses the session as
 * `session:<id>`, beside `run:<id>` and `dispatch:<id>`, and derives that spelling here rather than
 * storing it.
 *
 * Where the session runs is not part of the id; it is read from the session record when needed. PTY
 * agents have none today, and never a pane-keyed one: a pane outlives the agent in it, so such an id
 * would be inherited by the pane's next occupant.
 */
export const ORCA_SESSION_ADDRESS_PREFIX = 'session:'

// Terminal handles (`term_` from the PTY runtime, `structworker_` from structured-worker-identity)
// share the session-id charset. A handle is never a session, so one handed over by mistake must not
// become a durable Orca session id.
const TERMINAL_HANDLE_PREFIXES = ['term_', 'structworker_'] as const

export function isOrcaSessionId(id: string): boolean {
  return isAgentSessionId(id) && !TERMINAL_HANDLE_PREFIXES.some((prefix) => id.startsWith(prefix))
}

export function formatOrcaSessionAddress(orcaSessionId: string): string {
  return `${ORCA_SESSION_ADDRESS_PREFIX}${orcaSessionId}`
}

/** The bare Orca session id of a `session:<id>` address; anything else reads as null. */
export function parseOrcaSessionAddress(address: string | null | undefined): string | null {
  if (!address?.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
    return null
  }
  const id = address.slice(ORCA_SESSION_ADDRESS_PREFIX.length)
  return isOrcaSessionId(id) ? id : null
}
