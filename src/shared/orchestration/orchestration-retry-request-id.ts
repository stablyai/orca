const RETRY_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const RETRY_REQUEST_ID_GUIDANCE =
  '--retry-request must be the UUID Orca reported for the original request; pass it exactly as printed, or omit the flag to start a new request.'

/** A replay-only retry found nothing to replay or join (the receipt may have been evicted after the
 *  original committed, or the request takes a route that keeps no receipt here), so it did not run. */
export const RETRY_NOT_REPLAYABLE_CODE = 'retry_not_replayable'

/** The CLI and the SSH relay shim parse argv separately; both gate replay identity on this shape. */
export function isOrchestrationRetryRequestId(value: unknown): value is string {
  return typeof value === 'string' && RETRY_REQUEST_ID_PATTERN.test(value)
}
