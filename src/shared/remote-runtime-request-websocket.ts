import WebSocket from 'ws'
import type { PairedRuntimeConnection } from './paired-runtime-connection'
import type { PairedE2EEClientHandshake } from './paired-e2ee-client-handshake'
import { createRemoteRuntimeClientHandshake } from './remote-runtime-client-handshake'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import {
  remoteRuntimeConnectFailureMessage,
  remoteRuntimeConnectOptions
} from './remote-runtime-connect-bound'
import { REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES } from './remote-runtime-memory-limits'
import {
  invalidRemoteRuntimeResponseError,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'

export type RemoteRuntimeWebSocket = {
  ws: WebSocket
  handshake: PairedE2EEClientHandshake
  cleanup: () => void
}

export type RemoteRuntimeWebSocketCallbacks = {
  onClose: (ws: WebSocket, code: number, reason: Buffer) => void
  onError: (ws: WebSocket, error: RemoteRuntimeClientError) => void
  onTextFrame: (ws: WebSocket, frame: string) => void
  // Why optional: request sockets treat a binary frame as a protocol error; a relay forwards it.
  onBinaryFrame?: (ws: WebSocket, frame: Uint8Array<ArrayBufferLike>) => void
  // Why: protocol-level pongs (and server heartbeat pings) are the liveness
  // signal for detecting half-open tunnels that never deliver `close` (#7718).
  onPong?: (ws: WebSocket) => void
  onPing?: (ws: WebSocket) => void
}

export function openRemoteRuntimeWebSocket(
  connection: PairedRuntimeConnection,
  callbacks: RemoteRuntimeWebSocketCallbacks,
  // Why: overridable so the connect-bound regression test can pin the behaviour
  // without spending the production budget of wall-clock time.
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
  }
  const onError = (error: Error): void => {
    callbacks.onError(
      ws,
      remoteRuntimeUnavailableError(remoteRuntimeConnectFailureMessage(error, connection.endpoint))
    )
  }
  const onClose = (code: number, reason: Buffer): void => callbacks.onClose(ws, code, reason)
  const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    if (isBinary && callbacks.onBinaryFrame && Buffer.isBuffer(data)) {
      callbacks.onBinaryFrame(ws, new Uint8Array(data))
      return
    }
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
    // Why: a manually closed ws can still emit a late transport error; keep
    // that from becoming an unhandled EventEmitter error after detaching Orca.
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
