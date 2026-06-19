import {
  RuntimeRpcEnvelopeSchema,
  type RuntimeRpcResponse,
  isKeepaliveFrame
} from './runtime-rpc-envelope'
import { RemoteRuntimeClientError } from './remote-runtime-client'

export type ParsedRemoteRuntimeFrame =
  | { type: 'keepalive' }
  | { type: 'response'; response: RuntimeRpcResponse<unknown> }
  | { type: 'error'; error: RemoteRuntimeClientError }

export function remoteRuntimeUnavailableError(
  message = 'Remote Orca runtime closed the connection.'
): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError('remote_runtime_unavailable', message)
}

export function remoteRuntimeTimeoutError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'runtime_timeout',
    'Timed out waiting for the remote Orca runtime to respond.'
  )
}

export function invalidRemoteRuntimeResponseError(message: string): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError('invalid_runtime_response', message)
}

export function parseReadyFrame(frame: string): RemoteRuntimeClientError | null {
  let ready: unknown
  try {
    ready = JSON.parse(frame)
  } catch {
    return invalidRemoteRuntimeResponseError(
      'Remote Orca runtime returned an invalid E2EE handshake frame.'
    )
  }
  if (
    typeof ready !== 'object' ||
    ready === null ||
    (ready as { type?: unknown }).type !== 'e2ee_ready'
  ) {
    return invalidRemoteRuntimeResponseError(
      'Remote Orca runtime returned an unexpected E2EE handshake frame.'
    )
  }
  return null
}

export function parseAuthenticatedFrame(plaintext: string): RemoteRuntimeClientError | null {
  let authenticated: unknown
  try {
    authenticated = JSON.parse(plaintext)
  } catch {
    return invalidRemoteRuntimeResponseError(
      'Remote Orca runtime returned an invalid E2EE auth frame.'
    )
  }
  const type = (authenticated as { type?: unknown }).type
  if (type === 'e2ee_authenticated') {
    return null
  }
  const code =
    typeof authenticated === 'object' &&
    authenticated !== null &&
    (authenticated as { error?: { code?: unknown } }).error?.code === 'unauthorized'
      ? 'unauthorized'
      : 'invalid_runtime_response'
  return new RemoteRuntimeClientError(code, 'Remote Orca runtime rejected the pairing token.')
}

export function parseRemoteRuntimeRpcFrame(plaintext: string): ParsedRemoteRuntimeFrame {
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return {
      type: 'error',
      error: invalidRemoteRuntimeResponseError(
        'Remote Orca runtime returned an invalid response frame.'
      )
    }
  }
  if (isKeepaliveFrame(raw)) {
    return { type: 'keepalive' }
  }
  const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
  if (!parsed.success || '_keepalive' in parsed.data) {
    return {
      type: 'error',
      error: invalidRemoteRuntimeResponseError(
        'Remote Orca runtime returned an invalid response frame.'
      )
    }
  }
  return { type: 'response', response: parsed.data as RuntimeRpcResponse<unknown> }
}
