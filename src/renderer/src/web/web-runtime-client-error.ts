const UNAUTHORIZED_MESSAGE = 'Unauthorized. Pair this web client again.'

export class WebRuntimeClientError extends Error {
  constructor(
    message: string,
    readonly code: 'unauthorized'
  ) {
    super(message)
    this.name = 'WebRuntimeClientError'
  }
}

export function createWebRuntimeUnauthorizedError(): WebRuntimeClientError {
  return new WebRuntimeClientError(UNAUTHORIZED_MESSAGE, 'unauthorized')
}

export function isWebRuntimeUnauthorizedError(
  error: unknown
): error is Error & { code: 'unauthorized' } {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'unauthorized'
  )
}
