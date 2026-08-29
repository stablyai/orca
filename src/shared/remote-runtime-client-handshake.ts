import { parseRemoteRuntimeJsonText } from './remote-runtime-request-frames'

export type RemoteRuntimeHandshakeState = 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

export type RemoteRuntimeAuthenticatedFrame =
  | { kind: 'authenticated' }
  | { kind: 'rejected'; unauthorized: boolean }
  | { kind: 'invalid' }

export function classifyRemoteRuntimeReadyFrame(frame: string): 'ready' | 'invalid' | 'unexpected' {
  let ready: unknown
  try {
    ready = parseRemoteRuntimeJsonText(frame)
  } catch {
    return 'invalid'
  }
  return typeof ready === 'object' &&
    ready !== null &&
    (ready as { type?: unknown }).type === 'e2ee_ready'
    ? 'ready'
    : 'unexpected'
}

export function parseRemoteRuntimeAuthenticatedFrame(
  plaintext: string
): RemoteRuntimeAuthenticatedFrame {
  let authenticated: unknown
  try {
    authenticated = parseRemoteRuntimeJsonText(plaintext)
  } catch {
    return { kind: 'invalid' }
  }
  if ((authenticated as { type?: unknown }).type === 'e2ee_authenticated') {
    return { kind: 'authenticated' }
  }
  return {
    kind: 'rejected',
    unauthorized:
      typeof authenticated === 'object' &&
      authenticated !== null &&
      (authenticated as { error?: { code?: unknown } }).error?.code === 'unauthorized'
  }
}

export function formatRemoteRuntimeCloseMessage(code: number, reason: Buffer): string {
  const suffixParts: string[] = []
  if (code !== 1005 && code !== 1006) {
    suffixParts.push(String(code))
  }
  const reasonText = reason.toString().trim()
  if (reasonText) {
    suffixParts.push(reasonText)
  }
  return suffixParts.length > 0
    ? `Remote Orca runtime closed the connection (${suffixParts.join(': ')}).`
    : 'Remote Orca runtime closed the connection.'
}

export function ignoreSettledRemoteRuntimeSocketError(): void {}
