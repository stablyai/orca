import {
  createPairedE2EEClientHandshake,
  type PairedE2EEClientHandshake
} from './paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from './paired-e2ee-node-primitives'
import { serializeRemoteRuntimePayload } from './remote-runtime-memory-limits'
import { parseRemoteRuntimeJsonText } from './remote-runtime-request-frames'

export type RemoteRuntimeHandshakeState = 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

// Desktop and CLI runtime clients: legacy framing, structure-limited parsing,
// size-limited auth serialization. Throws on an invalid host public key.
export function createRemoteRuntimeClientHandshake(
  hostPublicKeyB64: string
): PairedE2EEClientHandshake {
  return createPairedE2EEClientHandshake({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64,
    framing: 'legacy',
    parseJson: parseRemoteRuntimeJsonText,
    serializeJson: serializeRemoteRuntimePayload
  })
}

// Why: the auth step is async, so the socket can close or be replaced before the frame is
// sealed; `stillAwaiting` is re-checked then, and a seal failure goes to `fail`.
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
