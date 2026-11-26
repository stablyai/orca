import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import { RUNTIME_BINARY_CHANNELS_CAPABILITY } from '../protocol/runtime-binary-channel'
import { remoteRuntimeClientCapabilities } from '../remote-runtime-client-capabilities'
import type { RemoteRuntimeSharedControlConnectionOptions } from './remote-runtime-shared-control-types'
import { sendRemoteRuntimeTokenAuth } from '../remote-runtime-client-handshake'
import {
  acceptSealedReady,
  openSealedFrame,
  openSealedText,
  SEALED_FRAME_FAILURE_MESSAGES,
  type RemoteRuntimeSealedFrame
} from '../remote-runtime-sealed-frame'
import type { RemoteRuntimeSocketLivenessOptions } from '../remote-runtime-socket-liveness'
import type { RemoteRuntimeWebSocket } from '../requests/remote-runtime-request-websocket'
import {
  invalidRemoteRuntimeResponseError,
  remoteRuntimeAuthReplyError,
  remoteRuntimeReadyError
} from '../requests/remote-runtime-request-frames'
import type {
  AuthenticatedRuntimeChannel,
  AuthenticatedRuntimeChannelEvents,
  AuthenticatedRuntimeChannelOpener
} from './remote-runtime-authenticated-channel'
import { openSharedControlSocket } from './remote-runtime-shared-control-open'
import { toRemoteRuntimeClientError } from './remote-runtime-shared-control-protocol'
import { pairedRuntimeConnectionToken } from '../pairing/paired-runtime-connection'

/** What a control connection opens: its own opener (e.g. Relay), else a direct socket. */
export function controlChannelOpener(
  connection: PairedRuntimeConnection,
  options: Pick<
    RemoteRuntimeSharedControlConnectionOptions,
    'openChannel' | 'clientCapabilities' | 'liveness'
  >,
  binaryChannels: boolean
): AuthenticatedRuntimeChannelOpener {
  const clientCapabilities = remoteRuntimeClientCapabilities([
    ...(options.clientCapabilities ?? []),
    ...(binaryChannels ? [RUNTIME_BINARY_CHANNELS_CAPABILITY] : [])
  ])
  return (
    options.openChannel?.(clientCapabilities) ??
    directRuntimeChannelOpener(connection, { clientCapabilities, liveness: options.liveness })
  )
}

/** A direct socket to the host: its E2EE ready, then token auth, then sealed frames both ways. */
export function directRuntimeChannelOpener(
  connection: PairedRuntimeConnection,
  config: { clientCapabilities: readonly string[]; liveness?: RemoteRuntimeSocketLivenessOptions }
): AuthenticatedRuntimeChannelOpener {
  return (events) => openDirectRuntimeChannel(connection, config, events)
}

function openDirectRuntimeChannel(
  connection: PairedRuntimeConnection,
  config: { clientCapabilities: readonly string[]; liveness?: RemoteRuntimeSocketLivenessOptions },
  events: AuthenticatedRuntimeChannelEvents
): ReturnType<AuthenticatedRuntimeChannelOpener> {
  let phase: 'awaiting_ready' | 'awaiting_authenticated' | 'ready' = 'awaiting_ready'
  let socket: RemoteRuntimeWebSocket | null = null
  let ended = false
  const end: AuthenticatedRuntimeChannelEvents['onClosed'] = (error, cause, close) => {
    if (!ended) {
      ended = true
      events.onClosed(error, cause, close)
    }
  }
  const protocolError = (error: ReturnType<typeof toRemoteRuntimeClientError>): void =>
    end(error, 'protocol_error')

  const onFrame = (frame: RemoteRuntimeSealedFrame): void => {
    const current = socket
    if (!current || ended) {
      return
    }
    events.onAnswer()
    const { handshake, ws } = current
    if (phase === 'awaiting_ready') {
      const error = remoteRuntimeReadyError(acceptSealedReady(handshake, frame))
      if (error) {
        protocolError(error)
        return
      }
      phase = 'awaiting_authenticated'
      events.onAuthenticating()
      void sendRemoteRuntimeTokenAuth({
        handshake,
        deviceToken: pairedRuntimeConnectionToken(connection),
        clientCapabilities: config.clientCapabilities,
        stillAwaiting: () => !ended && phase === 'awaiting_authenticated' && ws.readyState === 1,
        send: (sealed) => ws.send(sealed),
        fail: (error) => protocolError(toRemoteRuntimeClientError(error))
      })
      return
    }
    if (phase === 'awaiting_authenticated') {
      const reply = openSealedText(handshake, frame)
      const error =
        reply.kind === 'failed'
          ? invalidRemoteRuntimeResponseError(reply.message)
          : remoteRuntimeAuthReplyError(handshake.classifyAuthReply(reply.text))
      if (error) {
        protocolError(error)
        return
      }
      phase = 'ready'
      events.onAuthenticated()
      return
    }
    const opened = openSealedFrame(handshake, frame)
    if (opened.kind === 'text') {
      events.onText(opened.text)
    } else if (opened.kind === 'binary') {
      events.onBinary(opened.bytes)
    } else {
      protocolError(
        invalidRemoteRuntimeResponseError(SEALED_FRAME_FAILURE_MESSAGES[opened.failure])
      )
    }
  }

  const opened = openSharedControlSocket(connection, {
    getCurrentSocket: () => (ended ? null : (socket?.ws ?? null)),
    onSocketClosed: end,
    onOpened: events.onTransportOpen,
    onFrame,
    onActivity: events.onActivity,
    liveness: { options: config.liveness, onRoundTrip: events.onRoundTrip }
  })
  if (!opened.ok) {
    return opened
  }
  socket = opened.socket
  const { ws, handshake, cleanup } = opened.socket
  const send = (frame: () => string | Uint8Array): boolean => {
    if (ended || ws.readyState !== 1) {
      return false
    }
    try {
      ws.send(frame())
      return true
    } catch {
      return false
    }
  }
  const channel: AuthenticatedRuntimeChannel = {
    state: () =>
      ended || ws.readyState > 1 ? 'closed' : ws.readyState === 1 ? 'open' : 'connecting',
    sendText: (plaintext) => send(() => handshake.channel.sealText(plaintext)),
    sendBinary: (plaintext) => send(() => handshake.channel.sealBinary(plaintext)),
    close: () => {
      ended = true
      try {
        cleanup()
        ws.close()
      } catch {
        // Best-effort close of the control socket.
      }
    }
  }
  return { ok: true, channel }
}
