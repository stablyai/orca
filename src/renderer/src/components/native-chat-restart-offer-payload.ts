import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import type { ResumeFailure } from './native-chat-resume-on-restart-grouping'

/** The host's answer as this side understands it. `failed` is optional on the wire: an older host
 *  never sends it, and its absence means nothing to show, not an invalid answer. */
export type HostOfferPayload = { sessions?: unknown; failed?: unknown }

export function failedFrom(payload: HostOfferPayload): ResumeFailure[] {
  // SAFETY: the host is the single writer of this shape; a malformed row is a host bug, not input.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
  return Array.isArray(payload.failed) ? (payload.failed as ResumeFailure[]) : []
}

/** A host that cannot hold restart offers at all: it predates the method, or has no structured
 *  chat surface for this client. Distinct from a read that failed, which proves nothing. */
export function hostCannotOffer(error: unknown): boolean {
  return (
    hasRuntimeRpcErrorCode(error, 'method_not_found') ||
    (error instanceof Error && error.message.includes('structured_agent_session_unsupported'))
  )
}
