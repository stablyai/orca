import { isAgentSessionId } from './agent-session-record'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from './structured-worker-handle'

/**
 * The Orca session id is the id Orca minted for a structured session (its session record id, the
 * value of `ORCA_AGENT_SESSION_ID`), never the provider's own session id. Orchestration stores,
 * bare, the one the agent is addressed by: for a `/clear`ed chat, its lineage root's, not the live
 * session's. Mail addresses the session as `session:<id>`, beside `run:<id>` and `dispatch:<id>`,
 * and derives that spelling here rather than storing it.
 *
 * Where the session runs is not part of the id; it is read from the session record when needed. PTY
 * agents have none today, and never a pane-keyed one: a pane outlives the agent in it, so such an id
 * would be inherited by the pane's next occupant.
 */
export const ORCA_SESSION_ADDRESS_PREFIX = 'session:'

declare const orcaSessionIdBrand: unique symbol
declare const orcaSessionAddressBrand: unique symbol

/** A bare Orca session id; only `isOrcaSessionId` and `parseOrcaSessionAddress` produce one. */
export type OrcaSessionId = string & { readonly [orcaSessionIdBrand]: true }
/** A `session:<id>` mail address; only `formatOrcaSessionAddress` produces one. */
export type OrcaSessionAddress = string & { readonly [orcaSessionAddressBrand]: true }

// Terminal handles (`term_` from the PTY runtime, `structworker_` from structured-worker-identity)
// share the session-id charset. A handle is never a session, so one handed over by mistake must not
// become a durable Orca session id.
const TERMINAL_HANDLE_PREFIXES = ['term_', STRUCTURED_WORKER_HANDLE_PREFIX] as const

export function isOrcaSessionId(id: string): id is OrcaSessionId {
  return isAgentSessionId(id) && !TERMINAL_HANDLE_PREFIXES.some((prefix) => id.startsWith(prefix))
}

export function formatOrcaSessionAddress(orcaSessionId: OrcaSessionId): OrcaSessionAddress {
  const address = `${ORCA_SESSION_ADDRESS_PREFIX}${orcaSessionId}`
  // Always true for a checked id; the check brands the address without a type assertion.
  if (!isOrcaSessionAddress(address)) {
    throw new Error(`Not an Orca session id: ${orcaSessionId}`)
  }
  return address
}

/** The bare Orca session id of a `session:<id>` address; anything else reads as null. */
export function parseOrcaSessionAddress(address: string | null | undefined): OrcaSessionId | null {
  if (!address?.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
    return null
  }
  const id = address.slice(ORCA_SESSION_ADDRESS_PREFIX.length)
  return isOrcaSessionId(id) ? id : null
}

function isOrcaSessionAddress(address: string): address is OrcaSessionAddress {
  return parseOrcaSessionAddress(address) !== null
}
