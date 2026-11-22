/** A host API rejection, as plugin code sees it from `host.call`. */
export type MockHostError = Error & { code: string; retryable: boolean; retryAfterMs?: number }

const RETRYABLE = new Set(['rate_limited', 'unavailable', 'timeout', 'conflict'])

/** The error `host.call` rejects with for `code`, e.g. `hostError('rate_limited', 'slow down', 500)`. */
export function hostError(code: string, message = code, retryAfterMs?: number): MockHostError {
  return Object.assign(new Error(message), {
    code,
    retryable: RETRYABLE.has(code),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  })
}
