import type { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'
import type {
  WebRuntimeConnectionLifecycle,
  WebRuntimeConnectionAuth
} from './web-runtime-connection-auth'
import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import {
  createPairedE2EEClientHandshake,
  type PairedE2EEClientHandshake
} from '../../../shared/paired-e2ee-client-handshake'
import type { WebRuntimeAuthPlan } from './web-runtime-credential-source'
import type { WebRuntimeConnectionTimers } from './web-runtime-connection-timers'
import { WEB_PAIRED_E2EE_PRIMITIVES } from './web-paired-e2ee-primitives'

export function installWebRuntimeSocket({
  socket,
  connection,
  plan,
  auth,
  timers,
  owner,
  noteInboundFrame,
  rejectUnavailable,
  isClosed,
  failSetup,
  finite,
  assertCurrent
}: {
  socket: WebSocket
  connection: PairedRuntimeConnection
  plan: WebRuntimeAuthPlan
  auth: WebRuntimeConnectionAuth
  timers: WebRuntimeConnectionTimers
  owner: Pick<
    WebRuntimeConnectionTransport,
    'ws' | 'state' | 'handshake' | 'setState' | 'handleSocketClosed' | 'handleSocketMessage'
  >
  noteInboundFrame: () => void
  rejectUnavailable: () => void
  isClosed: () => boolean
  failSetup: (error: unknown) => void
  finite: boolean
  assertCurrent?: () => void
}): void {
  owner.setState('connecting')
  timers.arm('connect', 12_000, () => {
    if (owner.ws === socket && socket.readyState === WebSocket.CONNECTING) {
      try {
        socket.close()
      } catch (error) {
        if (!finite) {
          throw error
        }
        failSetup(error)
      }
      owner.handleSocketClosed(socket)
    }
  })
  socket.onopen = () => {
    if (owner.ws !== socket) {
      return
    }
    try {
      assertCurrent?.()
      timers.clear('connect')
      owner.setState('handshaking')
      const handshake = createPairedE2EEClientHandshake({
        primitives: WEB_PAIRED_E2EE_PRIMITIVES,
        hostPublicKeyB64: connection.hostPublicKeyB64,
        framing: auth.framingFor(plan),
        transport: 'direct'
      })
      owner.handshake = handshake
      socket.send(handshake.helloText())
      timers.arm('handshake', 10_000, () => {
        if (owner.ws === socket && (owner.state === 'handshaking' || owner.state === 'migrating')) {
          try {
            socket.close()
          } catch (error) {
            if (!finite) {
              throw error
            }
            failSetup(error)
          }
          owner.handleSocketClosed(socket)
        }
      })
    } catch (error) {
      if (!finite) {
        throw error
      }
      failSetup(error)
    }
  }
  socket.onmessage = (event) => {
    if (owner.ws !== socket) {
      return
    }
    noteInboundFrame()
    const message = owner.handleSocketMessage(event.data, socket)
    if (finite) {
      void message.catch((error: unknown) => {
        if (owner.ws === socket && !isClosed()) {
          failSetup(error)
        }
      })
    }
  }
  socket.onclose = () => owner.handleSocketClosed(socket)
  socket.onerror = () => {
    if (owner.ws === socket && owner.state === 'connecting') {
      rejectUnavailable()
    }
  }
}

export function sendWebRuntimeSocketAuth(
  handshake: PairedE2EEClientHandshake,
  {
    owner,
    connection,
    authOwner,
    lifecycle,
    isClosed,
    failSetup
  }: {
    owner: Pick<WebRuntimeConnectionTransport, 'ws' | 'handshake' | 'state'>
    connection: PairedRuntimeConnection
    authOwner: WebRuntimeConnectionAuth
    lifecycle: WebRuntimeConnectionLifecycle
    isClosed: () => boolean
    failSetup: (error: unknown) => void
  }
): void {
  const socket = owner.ws
  const auth = authOwner.sendAuth({
    handshake,
    fallbackToken: connection.credential.deviceToken,
    // Why: the socket may have closed or been replaced while the auth step ran.
    isCurrent: () =>
      owner.handshake === handshake &&
      owner.ws === socket &&
      socket?.readyState === WebSocket.OPEN &&
      owner.state === 'handshaking',
    send: (frame) => {
      lifecycle.assertCurrent?.()
      socket?.send(frame)
    },
    fail: (error) => {
      if (!lifecycle.crewAttempt) {
        socket?.close()
      } else if (owner.ws === socket && !isClosed()) {
        failSetup(error)
      }
    }
  })
  if (lifecycle.crewAttempt) {
    void auth.catch((error: unknown) => {
      if (owner.ws === socket && !isClosed()) {
        failSetup(error)
      }
    })
  }
}

export function closeWebRuntimeSocket(
  owner: Pick<WebRuntimeConnectionTransport, 'ws' | 'handshake' | 'setState'>,
  finite: boolean,
  recordFailure: (error: unknown) => void
): void {
  if (finite) {
    const socket = owner.ws
    owner.ws = null
    owner.handshake = null
    owner.setState('disconnected')
    try {
      socket?.close()
    } catch (error) {
      recordFailure(error)
    }
  } else {
    owner.ws?.close()
    owner.ws = null
    owner.handshake = null
    owner.setState('disconnected')
  }
}
