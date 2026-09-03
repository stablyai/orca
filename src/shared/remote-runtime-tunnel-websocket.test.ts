import { connect, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { PAIRING_OFFER_VERSION, type PairingOffer } from './mobile-relay-pairing-offer'
import { generateKeyPair, publicKeyToBase64 } from './e2ee-crypto'
import {
  openRemoteRuntimeWebSocket,
  TUNNEL_DIALER_UNAVAILABLE_MESSAGE
} from './remote-runtime-request-websocket'
import {
  createRemoteRuntimeWebSocket,
  RemoteRuntimeTunnelAgent,
  setRemoteRuntimeTunnelDialer
} from './remote-runtime-tunnel-dialer'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { sendRemoteRuntimeRequest } from './remote-runtime-client'
import { subscribeRemoteRuntimeTransport } from './remote-runtime-subscription-transport'

const tunnel = { v: 1 as const, kind: 'tailcat' as const, token: 'tcTOKEN', port: 6768 }

function pairingOffer(endpoint: string): PairingOffer {
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: publicKeyToBase64(generateKeyPair().publicKey),
    scope: 'runtime',
    tunnel
  }
}

describe('openRemoteRuntimeWebSocket with a tunnel offer', () => {
  const cleanups: (() => Promise<void> | void)[] = []

  afterEach(async () => {
    setRemoteRuntimeTunnelDialer(null)
    // Why LIFO: the server's close waits for its clients, so sockets opened later must go first.
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  it('dials through the registered tunnel dialer instead of the advertised endpoint', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const serverPort = (server.address() as AddressInfo).port
    const firstFrame = new Promise<string>((resolve) => {
      server.once('connection', (socket) => {
        socket.once('message', (data) => resolve(data.toString()))
      })
    })
    const dialed: (typeof tunnel)[] = []
    setRemoteRuntimeTunnelDialer(async (requested) => {
      dialed.push(requested)
      return connect({ host: '127.0.0.1', port: serverPort })
    })

    // Why port 1: the advertised endpoint must be unreachable so a direct dial would fail loudly.
    const opened = openRemoteRuntimeWebSocket(pairingOffer('ws://127.0.0.1:1'), {
      onClose: () => {},
      onError: () => {},
      onTextFrame: () => {}
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) {
      return
    }
    cleanups.push(() => {
      opened.socket.cleanup()
      opened.socket.ws.terminate()
    })
    const hello = JSON.parse(await firstFrame) as { type?: string }
    expect(hello.type).toBe('e2ee_hello')
    expect(dialed).toEqual([tunnel])
  })

  it('explains the missing tailcat CLI when only a loopback fallback remains', () => {
    const opened = openRemoteRuntimeWebSocket(pairingOffer('ws://127.0.0.1:6768'), {
      onClose: () => {},
      onError: () => {},
      onTextFrame: () => {}
    })
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.error.message).toBe(TUNNEL_DIALER_UNAVAILABLE_MESSAGE)
    }
  })

  it('dials a routable advertised endpoint directly when no dialer is registered', () => {
    const opened = openRemoteRuntimeWebSocket(pairingOffer('ws://192.0.2.1:1'), {
      onClose: () => {},
      onError: () => {},
      onTextFrame: () => {}
    })
    // Why: an older client, or one without tailcat, must still try the address the host advertised.
    expect(opened.ok).toBe(true)
    if (opened.ok) {
      opened.socket.cleanup()
      opened.socket.ws.terminate()
    }
  })
})

describe('createRemoteRuntimeWebSocket', () => {
  afterEach(() => {
    setRemoteRuntimeTunnelDialer(null)
  })

  it('attaches the tunnel agent for every caller, keeping their own socket options', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const serverPort = (server.address() as AddressInfo).port
    server.on('connection', (socket) => socket.send('x'.repeat(20)))
    setRemoteRuntimeTunnelDialer(async () => connect({ host: '127.0.0.1', port: serverPort }))
    try {
      const ws = createRemoteRuntimeWebSocket(pairingOffer('ws://192.0.2.1:1'), { maxPayload: 7 })
      const request = (ws as unknown as { _req?: { agent?: unknown } })._req
      expect(request?.agent).toBeInstanceOf(RemoteRuntimeTunnelAgent)
      // Why: a 20-byte frame against maxPayload 7 must be refused, proving the option survived.
      const failure = await new Promise<string>((resolve) => {
        ws.once('error', (error) => resolve(error.message))
        ws.once('close', (code) => resolve(`closed ${code}`))
      })
      expect(failure).toBe('Max payload size exceeded')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('throws a client error when the only fallback is loopback and no dialer exists', () => {
    let thrown: unknown
    try {
      createRemoteRuntimeWebSocket(pairingOffer('ws://127.0.0.1:6768'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RemoteRuntimeClientError)
    expect((thrown as RemoteRuntimeClientError).code).toBe('remote_runtime_unavailable')
    expect((thrown as RemoteRuntimeClientError).message).toBe(TUNNEL_DIALER_UNAVAILABLE_MESSAGE)
  })

  // Why: these two paths once built their own sockets and dialed a tunnel-only host directly.
  it('is what one-shot requests and subscriptions dial through', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const serverPort = (server.address() as AddressInfo).port
    server.on('connection', (socket) => socket.close())
    const dialed: string[] = []
    setRemoteRuntimeTunnelDialer(async (requested) => {
      dialed.push(requested.token)
      return connect({ host: '127.0.0.1', port: serverPort })
    })
    try {
      await expect(
        sendRemoteRuntimeRequest(pairingOffer('ws://192.0.2.1:1'), 'status.get', undefined, 5_000)
      ).rejects.toBeInstanceOf(RemoteRuntimeClientError)
      await expect(
        subscribeRemoteRuntimeTransport(
          pairingOffer('ws://192.0.2.1:1'),
          'status.get',
          undefined,
          5_000,
          {
            onResponse: () => {},
            onError: () => {}
          }
        )
      ).rejects.toBeInstanceOf(RemoteRuntimeClientError)
      expect(dialed).toEqual(['tcTOKEN', 'tcTOKEN'])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
