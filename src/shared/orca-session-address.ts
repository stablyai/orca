import { isAgentSessionId } from './agent-session-record'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from './structured-worker-handle'
import { ORCA_SESSION_ADDRESS_PREFIX } from './orca-session-address-prefix'

/** Orca-minted structured session identity (record id/ORCA_AGENT_SESSION_ID), never provider identity. Orchestration stores bare lineage-root ids after /clear,
 * not live replacement ids; derive mail spelling orca_session_id:<id> alongside run:/dispatch: addresses.
 * Resolve execution location from records. PTYs have no id today; never use pane keys because later agents inherit panes. */
export { ORCA_SESSION_ADDRESS_PREFIX }

declare const orcaSessionIdBrand: unique symbol
declare const orcaSessionAddressBrand: unique symbol

/** A bare Orca session id; only `isOrcaSessionId` and `parseOrcaSessionAddress` produce one. */
export type OrcaSessionId = string & { readonly [orcaSessionIdBrand]: true }
/** An `orca_session_id:<id>` mail address; only `formatOrcaSessionAddress` produces one. */
export type OrcaSessionAddress = string & { readonly [orcaSessionAddressBrand]: true }

// Terminal handles (term_/structworker_) share the charset but are never durable session ids.
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

/** The bare Orca session id of an `orca_session_id:<id>` address; anything else reads as null. */
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
