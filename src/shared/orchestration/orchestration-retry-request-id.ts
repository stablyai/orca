const RETRY_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const RETRY_REQUEST_ID_GUIDANCE =
  '--retry-request must be the UUID Orca reported for the original request; pass it exactly as printed, or omit the flag to start a new request.'

/** A keyed retry that follows a possibly delivered timeout found no receipt: it may have been
 *  evicted after the original committed, so the runtime refuses rather than writing again. */
export const RETRY_RECEIPT_ABSENT_CODE = 'retry_receipt_absent'

/** The CLI and the SSH relay shim parse argv separately; both gate replay identity on this shape. */
export function isOrchestrationRetryRequestId(value: unknown): value is string {
  return typeof value === 'string' && RETRY_REQUEST_ID_PATTERN.test(value)
}
