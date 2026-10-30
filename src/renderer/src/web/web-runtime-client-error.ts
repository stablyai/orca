import { translate } from '@/i18n/i18n'

export type WebRuntimeAuthFailureReason =
  | 'unauthorized'
  | 'device-revoked'
  | 'device-downgraded'
  | 'insecure-origin'

export class WebRuntimeClientError extends Error {
  constructor(
    message: string,
    readonly code: 'unauthorized',
    readonly reason: WebRuntimeAuthFailureReason = 'unauthorized'
  ) {
    super(message)
    this.name = 'WebRuntimeClientError'
  }
}

// Why one code: every reason leaves this browser unable to connect until the user acts.
export function createWebRuntimeUnauthorizedError(
  reason: WebRuntimeAuthFailureReason = 'unauthorized'
): WebRuntimeClientError {
  return new WebRuntimeClientError(webRuntimeAuthFailureMessage(reason), 'unauthorized', reason)
}

function webRuntimeAuthFailureMessage(reason: WebRuntimeAuthFailureReason): string {
  switch (reason) {
    case 'insecure-origin':
      return translate(
        'auto.web.runtimeAuth.insecureOrigin',
        'Orca refused to pair from this page: it is plain http on another machine, so anyone on the network path could replace it and take the pairing code. Open the web client over https, at localhost on this computer, or through an SSH tunnel. To allow it anyway, the server operator can restart Orca with ORCA_ALLOW_INSECURE_WEB_PAIRING=1.'
      )
    case 'device-downgraded':
      return translate(
        'auto.web.runtimeAuth.deviceDowngraded',
        'This Orca server no longer supports this browser’s sign-in key (it may have been downgraded). Update the server, or pair this browser again.'
      )
    case 'device-revoked':
    case 'unauthorized':
      return translate(
        'auto.web.runtimeAuth.unauthorized',
        'Unauthorized. Pair this web client again.'
      )
  }
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
