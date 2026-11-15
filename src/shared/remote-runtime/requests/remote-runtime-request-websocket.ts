import WebSocket from 'ws'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import type { PairedE2EEClientHandshake } from '../e2ee/paired-e2ee-client-handshake'
import { createRemoteRuntimeClientHandshake } from '../remote-runtime-client-framing'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import {
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from '../remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from '../remote-runtime-memory-limits'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { readSealedFrame, type RemoteRuntimeSealedFrame } from '../remote-runtime-sealed-frame'

export type RemoteRuntimeWebSocket = {
  ws: WebSocket
  handshake: PairedE2EEClientHandshake
  cleanup: () => void
}

export type RemoteRuntimeWebSocketCallbacks = {
  /** The opening handshake completed and the E2EE hello was sent. */
  onOpen?: (ws: WebSocket) => void
  onClose: (ws: WebSocket, code: number, reason: Buffer) => void
  onError: (ws: WebSocket, error: RemoteRuntimeClientError) => void
  // Binary frames may carry compressed text, so readers open both kinds the same way.
  onFrame: (ws: WebSocket, frame: RemoteRuntimeSealedFrame) => void
  // Pongs and heartbeat pings expose half-open tunnels that never emit close (#7718).
  onPong?: (ws: WebSocket) => void
  onPing?: (ws: WebSocket) => void
}

export function openRemoteRuntimeWebSocket(
  connection: PairedRuntimeConnection,
  callbacks: RemoteRuntimeWebSocketCallbacks,
  // Override for connect-bound tests without waiting the production timeout.
  connectTimeoutMs?: number
): { ok: true; socket: RemoteRuntimeWebSocket } | { ok: false; error: RemoteRuntimeClientError } {
  const opened = createSocket(connection, connectTimeoutMs)
  if (!opened.ok) {
    return opened
  }
  const { ws, handshake } = opened

  let cleanedUp = false
  const onOpen = (): void => {
    ws.send(handshake.helloText())
    callbacks.onOpen?.(ws)
  }
  const onError = (error: Error): void => {
    callbacks.onError(
      ws,
      remoteRuntimeUnavailableError(remoteRuntimeConnectFailureMessage(error, connection.endpoint))
    )
  }
  const onClose = (code: number, reason: Buffer): void => callbacks.onClose(ws, code, reason)
  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    callbacks.onFrame(ws, readSealedFrame(data, isBinary))
  }
  const onPong = (): void => callbacks.onPong?.(ws)
  const onPing = (): void => callbacks.onPing?.(ws)
  const cleanup = (): void => {
    if (cleanedUp) {
      return
    }
    cleanedUp = true
    ws.off('open', onOpen)
    ws.off('error', onError)
    ws.off('close', onClose)
    ws.off('message', onMessage)
    ws.off('pong', onPong)
    ws.off('ping', onPing)
    // Retain an error listener for late transport errors after manual close.
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.on('error', ignoreLateSocketError)
    }
  }

  ws.once('open', onOpen)
  ws.on('error', onError)
  ws.on('close', onClose)
  ws.on('message', onMessage)
  ws.on('pong', onPong)
  ws.on('ping', onPing)
  return { ok: true, socket: { ws, handshake, cleanup } }
}

function ignoreLateSocketError(): void {}

function createSocket(
  connection: PairedRuntimeConnection,
  connectTimeoutMs?: number
):
  | { ok: true; ws: WebSocket; handshake: PairedE2EEClientHandshake }
  | { ok: false; error: RemoteRuntimeClientError } {
  let handshake: PairedE2EEClientHandshake
  try {
    handshake = createRemoteRuntimeClientHandshake(connection.hostPublicKeyB64)
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
    return {
      ok: true,
      // Why: no runtime frame exceeds this, so a larger one is a broken peer, not a payload to buffer.
      ws: new WebSocket(
        connection.endpoint,
        remoteRuntimeConnectOptions(
          { maxPayload: REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES },
          connectTimeoutMs
        )
      ),
      handshake
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: new RemoteRuntimeClientError('invalid_argument', `Invalid remote endpoint: ${message}`)
    }
  }
}
