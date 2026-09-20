import { connect, Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  PAIRING_OFFER_VERSION,
  type PairingOffer,
  type PairingTunnel
} from './mobile-relay-pairing-offer'
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
import {
  REMOTE_RUNTIME_CONNECT_TIMEOUT_MS,
  WS_HANDSHAKE_TIMEOUT_MESSAGE
} from './remote-runtime-connect-bound'

const tunnel: PairingTunnel = { v: 1, kind: 'tailcat', token: 'tcTOKEN', port: 6768 }

function listeningPort(server: WebSocketServer): number {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected WebSocket server to listen on a TCP port')
  }
  return address.port
}

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

describe('RemoteRuntimeTunnelAgent connect deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a tunnel dial that never resolves at the caller-provided deadline', async () => {
    const never = Promise.withResolvers<Socket>().promise
    let receivedSignal: AbortSignal | undefined
    const agent = new RemoteRuntimeTunnelAgent(
      tunnel,
      (_tunnel, signal) => {
        receivedSignal = signal
        return never
      },
      37
    )
    const result = Promise.withResolvers<Error | null>()
    let callbackCount = 0

    agent.createConnection({}, (error) => {
      callbackCount += 1
      result.resolve(error)
    })
    await vi.advanceTimersByTimeAsync(36)
    expect(callbackCount).toBe(0)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result.promise).resolves.toMatchObject({
      message: WS_HANDSHAKE_TIMEOUT_MESSAGE
    })
    expect(callbackCount).toBe(1)
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('uses the default deadline and destroys a socket that arrives after it', async () => {
    const pending = Promise.withResolvers<Socket>()
    const agent = new RemoteRuntimeTunnelAgent(tunnel, () => pending.promise)
    const callbackErrors: (Error | null)[] = []
    const callbackFinished = Promise.withResolvers<void>()

    agent.createConnection({}, (error) => {
      callbackErrors.push(error)
      callbackFinished.resolve()
    })
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_CONNECT_TIMEOUT_MS - 1)
    expect(callbackErrors).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await callbackFinished.promise

    const lateSocket = new Socket()
    const destroy = vi.spyOn(lateSocket, 'destroy')
    pending.resolve(lateSocket)
    await Promise.resolve()

    expect(callbackErrors).toHaveLength(1)
    expect(callbackErrors[0]?.message).toBe(WS_HANDSHAKE_TIMEOUT_MESSAGE)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('cancels the deadline when the tunnel dial resolves in time', async () => {
    const pending = Promise.withResolvers<Socket>()
    const agent = new RemoteRuntimeTunnelAgent(tunnel, () => pending.promise, 25)
    const callbackResults: { error: Error | null; socket: Socket }[] = []
    const socket = new Socket()
    const destroy = vi.spyOn(socket, 'destroy')

    agent.createConnection({}, (error, stream) => {
      if (!(stream instanceof Socket)) {
        throw new Error('Expected tunnel dialer to return a Socket')
      }
      callbackResults.push({ error, socket: stream })
    })
    pending.resolve(socket)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(25)

    expect(callbackResults).toEqual([{ error: null, socket }])
    expect(destroy).not.toHaveBeenCalled()
    socket.destroy()
  })
})

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
    const serverPort = listeningPort(server)
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
    expect(JSON.parse(await firstFrame)).toMatchObject({ type: 'e2ee_hello' })
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
    const serverPort = listeningPort(server)
    server.on('connection', (socket) => socket.send('x'.repeat(20)))
    setRemoteRuntimeTunnelDialer(async () => connect({ host: '127.0.0.1', port: serverPort }))
    try {
      const ws = createRemoteRuntimeWebSocket(pairingOffer('ws://192.0.2.1:1'), { maxPayload: 7 })
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

  it('uses plaintext WebSocket framing over the tunnel when the fallback endpoint is wss', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const serverPort = listeningPort(server)
    setRemoteRuntimeTunnelDialer(async () => connect({ host: '127.0.0.1', port: serverPort }))
    try {
      const ws = createRemoteRuntimeWebSocket(pairingOffer('wss://remote.example:443'))
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve())
        ws.close()
      })
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
    if (!(thrown instanceof RemoteRuntimeClientError)) {
      throw new Error('Expected a RemoteRuntimeClientError')
    }
    expect(thrown.code).toBe('remote_runtime_unavailable')
    expect(thrown.message).toBe(TUNNEL_DIALER_UNAVAILABLE_MESSAGE)
  })

  // Why: these two paths once built their own sockets and dialed a tunnel-only host directly.
  it('is what one-shot requests and subscriptions dial through', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const serverPort = listeningPort(server)
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
