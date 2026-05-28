import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import {
  deriveSharedKey,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import { RemoteRuntimeClientError } from './remote-runtime-client'
import {
  invalidRemoteRuntimeResponseError,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'

export type RemoteRuntimeWebSocket = {
  ws: WebSocket
  sharedKey: Uint8Array
}

export type RemoteRuntimeWebSocketCallbacks = {
  onClose: (ws: WebSocket) => void
  onError: (ws: WebSocket, error: RemoteRuntimeClientError) => void
  onTextFrame: (ws: WebSocket, frame: string) => void
}

export function openRemoteRuntimeWebSocket(
  pairing: PairingOffer,
  callbacks: RemoteRuntimeWebSocketCallbacks
): { ok: true; socket: RemoteRuntimeWebSocket } | { ok: false; error: RemoteRuntimeClientError } {
  const opened = createSocket(pairing)
  if (!opened.ok) {
    return opened
  }
  const { ws, keyPair } = opened
  const serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
  const sharedKey = deriveSharedKey(keyPair.secretKey, serverPublicKey)

  ws.once('open', () => {
    ws.send(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(keyPair.publicKey)
      })
    )
  })
  ws.on('error', () => {
    callbacks.onError(
      ws,
      remoteRuntimeUnavailableError('Could not connect to the remote Orca runtime.')
    )
  })
  ws.on('close', () => callbacks.onClose(ws))
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      callbacks.onError(
        ws,
        invalidRemoteRuntimeResponseError(
          'Remote Orca runtime returned an unexpected binary frame.'
        )
      )
      return
    }
    callbacks.onTextFrame(ws, data.toString())
  })
  return { ok: true, socket: { ws, sharedKey } }
}

function createSocket(
  pairing: PairingOffer
):
  | { ok: true; ws: WebSocket; keyPair: ReturnType<typeof generateKeyPair> }
  | { ok: false; error: RemoteRuntimeClientError } {
  let keyPair: ReturnType<typeof generateKeyPair>
  try {
    keyPair = generateKeyPair()
    publicKeyFromBase64(pairing.publicKeyB64)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: new RemoteRuntimeClientError(
        'invalid_argument',
        `Invalid remote pairing key: ${message}`
      )
    }
  }
  try {
    return { ok: true, ws: new WebSocket(pairing.endpoint), keyPair }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: new RemoteRuntimeClientError('invalid_argument', `Invalid remote endpoint: ${message}`)
    }
  }
}
