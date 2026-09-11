// What a hold attempt actually said.
//
// A host that answers and has no hold method is an update prompt; a host that never answered is a
// read-only pane; a host that refused named a reason and a recovery. Collapsing all three into
// `undefined` made a session that was never reserved look exactly like one that was.

import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'

/** Lease refusals the host raises from a hold; each names a different recovery. */
export const STRUCTURED_AGENT_SESSION_HOLD_REFUSAL_CODES = [
  'execution_owner_reconciling',
  'agent_session_conflict',
  'agent_session_ownership_unknown'
] as const

/** Stand-in for a failure the host gave no code for, so the notice still has something to name. */
export const STRUCTURED_AGENT_SESSION_HOLD_FAILED_CODE = 'agent_session_hold_failed'

export type StructuredAgentSessionHoldOutcome =
  | { kind: 'held' }
  /** The host answered and has no hold method: readable, just not reserved. */
  | { kind: 'unsupported' }
  | { kind: 'refused'; code: string }
  /** The host never answered, so nothing here can be told apart from a host that is gone. */
  | { kind: 'unreachable' }

export type StructuredAgentSessionHoldState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | StructuredAgentSessionHoldOutcome

const HOLD_ABSENT_CODES = ['method_not_found', 'structured_agent_session_unsupported'] as const

/**
 * `host` decides where an uncoded failure lands, and it is the whole difference between the two
 * degraded panes: a paired host that stopped completing calls has gone quiet, while main is
 * in-process and always answered — a local failure is a refusal to show, never lost contact.
 */
export function classifyStructuredAgentSessionHoldFailure(
  error: unknown,
  host: 'local' | 'paired'
): StructuredAgentSessionHoldOutcome {
  for (const code of HOLD_ABSENT_CODES) {
    if (hasRuntimeRpcErrorCode(error, code)) {
      return { kind: 'unsupported' }
    }
  }
  for (const code of STRUCTURED_AGENT_SESSION_HOLD_REFUSAL_CODES) {
    if (hasRuntimeRpcErrorCode(error, code)) {
      return { kind: 'refused', code }
    }
  }
  return host === 'paired'
    ? { kind: 'unreachable' }
    : { kind: 'refused', code: STRUCTURED_AGENT_SESSION_HOLD_FAILED_CODE }
}
