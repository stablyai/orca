import WebSocket from 'ws'
import type { PairedRuntimeConnection } from '../paired-runtime-connection'
import type { RuntimeCapability } from '../protocol-version'
import {
  formatRemoteRuntimeCloseMessage,
  sendRemoteRuntimeTokenAuth
} from '../remote-runtime-client-handshake'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { openRemoteRuntimeWebSocket } from './requests/remote-runtime-request-websocket'
import { closeRemoteRuntimeSocket } from '../remote-runtime-socket-close'
import {
  startRemoteRuntimeSocketLiveness,
  type RemoteRuntimeSocketLivenessOptions
} from '../remote-runtime-socket-liveness'
import { RemoteRuntimeSubscriptionOutbound } from './requests/remote-runtime-subscription-outbound'

export type RemoteRuntimePassthroughSocket = {
  /** Queues one plaintext RPC frame; false when the socket can no longer carry it. */
  send: (plaintext: string) => boolean
  close: () => void
}

export type RemoteRuntimePassthroughCallbacks = {
  onText: (plaintext: string) => void
  onBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  /** Called once when an open socket ends for any reason other than `close()`. */
  onClose: (error: RemoteRuntimeClientError) => void
}

/**
 * An authenticated E2EE socket that carries any number of requests and streams and hands every
 * decrypted frame back untouched. Why not the subscription transport: it owns one request id per
 * socket and fails on any other, while a relay forwards whatever its client multiplexes.
 */
export function openRemoteRuntimePassthroughSocket(
  connection: PairedRuntimeConnection,
  clientCapabilities: readonly RuntimeCapability[],
  callbacks: RemoteRuntimePassthroughCallbacks,
  options: RemoteRuntimeSocketLivenessOptions & { timeoutMs: number }
): Promise<RemoteRuntimePassthroughSocket> {
  return new Promise((resolve, reject) => {
    let state: 'awaiting_ready' | 'awaiting_authenticated' | 'ready' | 'ended' = 'awaiting_ready'
    const opened = openRemoteRuntimeWebSocket(connection, {
      onTextFrame: (_ws, frame) => onTextFrame(frame),
      onBinaryFrame: (_ws, frame) => {
        liveness.noteActivity()
        const bytes = state === 'ready' ? handshake.channel.openBinary(frame) : null
        if (!bytes) {
          end(protocolError('Remote Orca runtime returned an unreadable binary frame.'))
          return
        }
        callbacks.onBinary(bytes)
      },
      onError: (_ws, error) => end(error),
      onClose: (_ws, code, reason) =>
        end(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            formatRemoteRuntimeCloseMessage(code, reason)
          )
        ),
      onPong: () => liveness.noteActivity(),
      onPing: () => liveness.noteActivity()
    })
    if (!opened.ok) {
      reject(opened.error)
      return
    }
    const { ws, handshake, cleanup } = opened.socket
    const outbound = new RemoteRuntimeSubscriptionOutbound({ fail: (error) => end(error) })
    const timeout = setTimeout(
      () =>
        end(
          new RemoteRuntimeClientError(
            'runtime_timeout',
            'Timed out connecting to the remote Orca runtime.'
          )
        ),
      options.timeoutMs
    )
    const liveness = startRemoteRuntimeSocketLiveness({
      ping: () => {
        if (ws.readyState !== WebSocket.OPEN) {
          return false
        }
        ws.ping()
        return true
      },
      onDead: () =>
        end(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote Orca runtime stopped responding; the connection was reset.'
          )
        ),
      options
    })

    function end(error: RemoteRuntimeClientError | null): void {
      if (state === 'ended') {
        return
      }
      const wasReady = state === 'ready'
      state = 'ended'
      clearTimeout(timeout)
      liveness.stop()
      outbound.releaseQueues()
      outbound.retainSocketMemoryUntilClose(ws)
      cleanup()
      closeRemoteRuntimeSocket(ws)
      if (!wasReady) {
        reject(error ?? new RemoteRuntimeClientError('remote_runtime_unavailable', 'Closed.'))
      } else if (error) {
        callbacks.onClose(error)
      }
    }

    function protocolError(message: string): RemoteRuntimeClientError {
      return new RemoteRuntimeClientError('invalid_runtime_response', message)
    }

    function onTextFrame(frame: string): void {
      liveness.noteActivity()
      if (state === 'awaiting_ready') {
        if (handshake.acceptReadyText(frame) !== 'accepted') {
          end(protocolError('Remote Orca runtime returned an invalid E2EE handshake frame.'))
          return
        }
        state = 'awaiting_authenticated'
        void sendRemoteRuntimeTokenAuth({
          handshake,
          deviceToken: connection.credential.deviceToken,
          clientCapabilities,
          stillAwaiting: () => state === 'awaiting_authenticated',
          send: (authFrame) => ws.send(authFrame),
          fail: (error) =>
            end(
              error instanceof RemoteRuntimeClientError
                ? error
                : new RemoteRuntimeClientError('invalid_argument', String(error))
            )
        })
        return
      }
      const plaintext = handshake.channel.openText(frame)
      if (plaintext === null) {
        end(protocolError('Remote Orca runtime returned an undecryptable frame.'))
        return
      }
      if (state === 'ready') {
        callbacks.onText(plaintext)
        return
      }
      const authenticated = handshake.classifyAuthReply(plaintext)
      if (authenticated.kind !== 'authenticated') {
        end(
          authenticated.kind === 'rejected' && authenticated.errorCode === 'unauthorized'
            ? new RemoteRuntimeClientError(
                'unauthorized',
                'Remote Orca runtime rejected the pairing token.'
              )
            : protocolError('Remote Orca runtime returned an invalid E2EE auth frame.')
        )
        return
      }
      state = 'ready'
      clearTimeout(timeout)
      resolve({
        send: (plaintext) =>
          state === 'ready' && ws.readyState === WebSocket.OPEN
            ? outbound.enqueueRequest(ws, handshake.channel.sealText(plaintext))
            : false,
        close: () => end(null)
      })
    }
  })
}
