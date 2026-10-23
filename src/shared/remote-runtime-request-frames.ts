import {
  RuntimeRpcEnvelopeSchema,
  type RuntimeRpcResponse,
  isKeepaliveFrame
} from './runtime-rpc-envelope'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import type { PairedE2EEAuthReply, PairedE2EEReadyVerdict } from './paired-e2ee-client-handshake'

export const REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 256 * 1024,
  nestingDepth: 64
} as const

export function parseRemoteRuntimeJsonText(content: string): unknown {
  assertJsonTextStructureWithinLimits(content, REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS)
  return JSON.parse(content) as unknown
}

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

export function remoteRuntimeReadyError(
  verdict: PairedE2EEReadyVerdict
): RemoteRuntimeClientError | null {
  if (verdict === 'accepted') {
    return null
  }
  return invalidRemoteRuntimeResponseError(
    verdict === 'invalid'
      ? 'Remote Orca runtime returned an invalid E2EE handshake frame.'
      : 'Remote Orca runtime returned an unexpected E2EE handshake frame.'
  )
}

export function remoteRuntimeAuthReplyError(
  reply: PairedE2EEAuthReply
): RemoteRuntimeClientError | null {
  if (reply.kind === 'authenticated') {
    return null
  }
  if (reply.kind === 'invalid') {
    return invalidRemoteRuntimeResponseError(
      'Remote Orca runtime returned an invalid E2EE auth frame.'
    )
  }
  return new RemoteRuntimeClientError(
    reply.errorCode === 'unauthorized' ? 'unauthorized' : 'invalid_runtime_response',
    'Remote Orca runtime rejected the pairing token.'
  )
}

export function parseRemoteRuntimeRpcFrame(plaintext: string): ParsedRemoteRuntimeFrame {
  let raw: unknown
  try {
    raw = parseRemoteRuntimeJsonText(plaintext)
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
