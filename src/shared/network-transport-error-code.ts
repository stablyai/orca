import { errorOwnDataProperty } from './error-own-data-property'

/**
 * Extracts the transport reason behind a failed request as an allow-listed code.
 *
 * Why: when a request fails in transport — an untrusted TLS chain, DNS, a refused connection —
 * `fetch` rejects with the same message "fetch failed" for every one of them, and the reason
 * that tells them apart lives only on the nested `cause`. Callers cannot forward the raw error
 * because it can carry request URLs or credentials, so this returns nothing but an exact match
 * from the fixed vocabulary below.
 */

const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  // Certificate validation — untrusted, expired, or mismatched. A network that terminates TLS
  // with a root the OS trusts but Node does not shows up as the untrusted-chain codes.
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  // Reachability and name resolution.
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EPROTO',
  'ETIMEDOUT',
  // Undici surfaces its own timeouts rather than an errno.
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
])

// Why: undici nests cause chains, and a bound stops a self-referential chain from looping.
const MAX_CAUSE_DEPTH = 4

export function networkTransportErrorCode(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    const code = errorOwnDataProperty(current, 'code')
    if (typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code)) {
      return code
    }
    current = errorOwnDataProperty(current, 'cause')
  }
  return null
}
