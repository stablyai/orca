import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { WebRuntimeClient } from './web-runtime-client'
import { encryptBytes } from './web-e2ee'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64,
  encryptBytes as encryptSharedBytes
} from '../../../shared/e2ee-crypto'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  close = vi.fn()
  send = vi.fn()

  constructor(readonly _url: string) {}
}

describe('WebRuntimeClient', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('closes child subscription clients when the owning client closes', () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const child = { close: vi.fn() }

    ;(
      client as unknown as {
        childClients: Set<{ close: (options?: { notifySubscriptions?: boolean }) => void }>
      }
    ).childClients.add(child)

    client.close()

    expect(child.close).toHaveBeenCalledWith({ notifySubscriptions: true })
  })

  it('passes local close semantics to child subscription clients', () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const child = { close: vi.fn() }

    ;(
      client as unknown as {
        childClients: Set<{ close: (options?: { notifySubscriptions?: boolean }) => void }>
      }
    ).childClients.add(child)

    client.close({ notifySubscriptions: false })

    expect(child.close).toHaveBeenCalledWith({ notifySubscriptions: false })
  })

  it('does not report locally closed subscriptions as remote closes', () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const onClose = vi.fn()
    const internals = client as unknown as {
      subscriptions: Map<
        string,
        { method: string; params: unknown; callbacks: { onClose: typeof onClose } }
      >
    }
    internals.subscriptions.set('stream-1', {
      method: 'terminal.multiplex',
      params: {},
      callbacks: { onClose }
    })

    client.close({ notifySubscriptions: false })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('reports subscriptions closed when the owning client closes', () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const onClose = vi.fn()
    const internals = client as unknown as {
      subscriptions: Map<
        string,
        { method: string; params: unknown; callbacks: { onClose: typeof onClose } }
      >
    }
    internals.subscriptions.set('stream-1', {
      method: 'terminal.multiplex',
      params: {},
      callbacks: { onClose }
    })

    client.close()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('decrypts binary WebSocket frames into subscription callbacks', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const sharedKey = new Uint8Array(32).fill(7)
    const onBinary = vi.fn()
    const internals = client as unknown as {
      state: 'connected'
      sharedKey: Uint8Array
      subscriptions: Map<string, { callbacks: { onBinary: typeof onBinary } }>
      handleSocketMessage: (rawData: unknown) => Promise<void>
    }
    internals.state = 'connected'
    internals.sharedKey = sharedKey
    internals.subscriptions.set('stream-1', { callbacks: { onBinary } })

    const frame = new Uint8Array([1, 2, 3, 4])
    await internals.handleSocketMessage(encryptBytes(frame, sharedKey))

    expect(onBinary).toHaveBeenCalledWith(frame)
    client.close()
  })

  it('receives encrypted subscription binary frames over a paired web socket', async () => {
    vi.stubGlobal('WebSocket', WebSocket)
    const serverKeys = generateKeyPair()
    const frame = new Uint8Array([9, 8, 7])
    const wss = new WebSocketServer({ port: 0 })
    const sockets = new Set<WebSocket>()
    wss.on('connection', (socket) => {
      sockets.add(socket)
      let sharedKey: Uint8Array | null = null
      let authenticated = false
      socket.on('close', () => sockets.delete(socket))
      socket.on('message', (data, isBinary) => {
        if (isBinary || !sharedKey) {
          const raw = data.toString()
          const hello = JSON.parse(raw) as { publicKeyB64: string }
          const clientPublicKey = Uint8Array.from(Buffer.from(hello.publicKeyB64, 'base64'))
          sharedKey = deriveSharedKey(serverKeys.secretKey, clientPublicKey)
          socket.send(JSON.stringify({ type: 'e2ee_ready' }))
          return
        }
        const plaintext = decrypt(data.toString(), sharedKey)
        if (!plaintext) {
          return
        }
        const message = JSON.parse(plaintext) as { id?: string; type?: string }
        if (message.type === 'e2ee_auth') {
          authenticated = true
          socket.send(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
          return
        }
        if (!authenticated || !message.id) {
          return
        }
        const response = {
          id: message.id,
          ok: true,
          streaming: true,
          result: { type: 'ready' },
          _meta: { runtimeId: 'runtime-web-test' }
        } as RuntimeRpcResponse<unknown> & { streaming: true }
        socket.send(encrypt(JSON.stringify(response), sharedKey))
        socket.send(Buffer.from(encryptSharedBytes(frame, sharedKey)), { binary: true })
      })
    })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    const address = wss.address()
    if (!address || typeof address !== 'object') {
      throw new Error('Expected local WebSocket test server address')
    }
    let client: WebRuntimeClient | null = new WebRuntimeClient({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken: 'token',
      publicKeyB64: publicKeyToBase64(serverKeys.publicKey)
    })
    try {
      const binaryFrame = new Promise<Uint8Array<ArrayBufferLike>>((resolve) => {
        void client!.subscribe(
          'browser.screencast',
          { worktree: 'id:wt-1', page: 'page-1' },
          { onResponse: vi.fn(), onBinary: resolve },
          { timeoutMs: 5_000 }
        )
      })

      expect(Array.from(await binaryFrame)).toEqual([9, 8, 7])
    } finally {
      client.close()
      client = null
      for (const socket of sockets) {
        socket.close()
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
