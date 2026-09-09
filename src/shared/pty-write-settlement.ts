/**
 * Three-valued settlement for a PTY write, mirroring the `live`/`unverifiable`/`exited`
 * vocabulary the execution boundary already uses. Ambiguity is a value here: it is never a
 * rejected promise, never a bare `false`, and never an absent optional flag. Flattening any
 * of the three arms to a boolean is what let a lost SSH settlement clear a durable mailbox
 * reservation and write the same pointer bytes twice.
 */

/** Proven refusal: the write was declined before any byte could reach the transport. */
export type WriteRefusalReason =
  | 'transport_disposed'
  | 'transport_queue_full'
  | 'transport_rejected_before_handoff'
  | 'payload_exceeds_transport_limit'
  | 'endpoint_disconnected'
  | 'endpoint_awaiting_recovery'
  | 'encode_failed'
  | 'write_gate_denied'
  | 'provider_unavailable'
  | 'provider_refused_write'
  | 'provider_cannot_settle'

/** Delivery could not be proven either way. There is no catch-all member by design. */
export type WriteAmbiguityReason =
  | 'transport_settlement_lost'
  | 'settlement_timeout'
  | 'endpoint_write_threw'
  | 'provider_threw_after_handoff'

export type WriteSettlement =
  | Readonly<{ outcome: 'accepted' }>
  | Readonly<{ outcome: 'refused'; reason: WriteRefusalReason }>
  | Readonly<{
      outcome: 'unverifiable'
      reason: WriteAmbiguityReason
      /** The fact a durable reservation needs: whether bytes could already be in flight. */
      bytesHandedToTransport: boolean
    }>

/** Provider/transport acceptance only. Never proof that the agent consumed the bytes. */
export const WRITE_ACCEPTED: WriteSettlement = Object.freeze({ outcome: 'accepted' })

export function writeRefused(reason: WriteRefusalReason): WriteSettlement {
  return Object.freeze({ outcome: 'refused', reason })
}

export function writeUnverifiable(
  reason: WriteAmbiguityReason,
  bytesHandedToTransport: boolean
): WriteSettlement {
  return Object.freeze({ outcome: 'unverifiable', reason, bytesHandedToTransport })
}

/** Local providers settle synchronously; remote ones return a promise. */
export function isSettledWrite(
  result: WriteSettlement | Promise<WriteSettlement>
): result is WriteSettlement {
  return 'outcome' in result
}
