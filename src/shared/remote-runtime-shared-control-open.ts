import type WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import {
  openRemoteRuntimeWebSocket,
  type RemoteRuntimeWebSocket
} from './remote-runtime-request-websocket'
import { formatSharedControlCloseMessage } from './remote-runtime-shared-control-protocol'

export function openSharedControlSocket(
  pairing: PairingOffer,
  callbacks: {
    getCurrentSocket: () => WebSocket | null
    onClose: (close: { code: number; reason: string }, error: RemoteRuntimeClientError) => void
    onError: (error: RemoteRuntimeClientError) => void
    onTextFrame: (frame: string) => void
  }
): { ok: true; socket: RemoteRuntimeWebSocket } | { ok: false; error: RemoteRuntimeClientError } {
  return openRemoteRuntimeWebSocket(pairing, {
    onClose: (ws, code, reason) => {
      if (callbacks.getCurrentSocket() === ws) {
        callbacks.onClose(
          { code, reason: reason.toString() },
          remoteRuntimeUnavailableError(formatSharedControlCloseMessage(code, reason))
        )
      }
    },
    onError: (ws, error) => {
      if (callbacks.getCurrentSocket() === ws) {
        callbacks.onError(error)
      }
    },
    onTextFrame: (ws, frame) => {
      if (callbacks.getCurrentSocket() === ws) {
        callbacks.onTextFrame(frame)
      }
    }
  })
}
