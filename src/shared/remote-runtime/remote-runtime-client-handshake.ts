import type { PairedE2EEClientHandshake } from './e2ee/paired-e2ee-client-handshake'

export type RemoteRuntimeHandshakeState = 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

// Async auth sealing may outlive socket close/replacement; recheck stillAwaiting before send and route sealing errors to fail.
export async function sendRemoteRuntimeTokenAuth(args: {
  handshake: PairedE2EEClientHandshake
  deviceToken: string
  clientCapabilities: readonly string[]
  stillAwaiting: () => boolean
  send: (frame: string) => void
  fail: (error: unknown) => void
}): Promise<void> {
  let frame: string
  try {
    frame = await args.handshake.sealAuth(
      { kind: 'token', deviceToken: args.deviceToken },
      { clientCapabilities: args.clientCapabilities }
    )
  } catch (error) {
    args.fail(error)
    return
  }
  if (args.stillAwaiting()) {
    args.send(frame)
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
