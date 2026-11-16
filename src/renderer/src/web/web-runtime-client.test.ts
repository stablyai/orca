import { pairedRuntimeConnectionFromOffer } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

import '../../../shared/remote-runtime/e2ee/paired-e2ee-fixed-key-test-fixture'
import WebSocket, { WebSocketServer } from 'ws'
import { WebRuntimeClient } from './web-runtime-client'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64,
  encryptBytes as encryptSharedBytes
} from '../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import '../../../shared/remote-runtime/protocol/protocol-version'

const fakeSockets: FakeWebSocket[] = []

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()

  constructor(readonly _url: string) {
    fakeSockets.push(this)
  }
}

describe('WebRuntimeClient', () => {
  beforeEach(() => {
    fakeSockets.length = 0
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      // Connected-state heartbeat needs interval timers in the window stub.
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('closes a connecting child search socket immediately on abort and never starts after pre-abort', async () => {
    const client = new WebRuntimeClient(
      pairedRuntimeConnectionFromOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: Buffer.alloc(32).toString('base64')
      })
    )
    const controller = new AbortController()
    const pending = client.subscribe(
      'files.search',
      {},
      { onResponse: vi.fn() },
      { signal: controller.signal, timeoutMs: 15_000 }
    )
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const child = fakeSockets.at(-1)
    expect(child?.readyState).toBe(FakeWebSocket.CONNECTING)
    controller.abort()
    await rejection
    expect(child?.close).toHaveBeenCalledOnce()
    const count = fakeSockets.length
    await expect(
      client.subscribe('files.search', {}, { onResponse: vi.fn() }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fakeSockets).toHaveLength(count)
    client.close()
  })

  it('rejects pending connection waiters when the client closes', async () => {
    vi.useFakeTimers()
    const timerWindow = window as unknown as {
      setTimeout: typeof setTimeout
      clearTimeout: typeof clearTimeout
    }
    timerWindow.setTimeout = setTimeout
    timerWindow.clearTimeout = clearTimeout
    const client = new WebRuntimeClient(
      pairedRuntimeConnectionFromOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: Buffer.alloc(32).toString('base64')
      })
    )

    try {
      const callPromise = client.call('status.get', {}, { timeoutMs: 30_000 })

      client.close()

      await expect(callPromise).rejects.toThrow('Remote Orca runtime connection closed.')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires a socket whose handshake expires without waiting for the browser close event', async () => {
    vi.useFakeTimers()
    const timerWindow = window as unknown as {
      setTimeout: typeof setTimeout
      clearTimeout: typeof clearTimeout
    }
    timerWindow.setTimeout = setTimeout
    timerWindow.clearTimeout = clearTimeout
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const client = new WebRuntimeClient(
      pairedRuntimeConnectionFromOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: Buffer.alloc(32).toString('base64')
      })
    )

    try {
      const stalled = fakeSockets[0]!
      stalled.readyState = FakeWebSocket.OPEN
      stalled.onopen?.()
      const callPromise = client.call('status.get', {}, { timeoutMs: 30_000 })
      const settled = vi.fn()
      callPromise.then(settled, settled)

      // Browsers can hold a closing socket for tens of seconds before onclose fires.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(stalled.close).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(fakeSockets).toHaveLength(2)

      stalled.onerror?.()
      stalled.onclose?.()
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()
      expect(fakeSockets).toHaveLength(2)

      client.close()
      await expect(callPromise).rejects.toThrow('Remote Orca runtime connection closed.')
    } finally {
      client.close()
      random.mockRestore()
      vi.useRealTimers()
    }
  })

  it('receives encrypted subscription binary frames over a paired web socket', async () => {
    vi.stubGlobal('WebSocket', WebSocket)
    const serverKeys = generateKeyPair()
    const frame = new Uint8Array([9, 8, 7])
    // Bind the dialed 127.0.0.1 address; wildcard binding lets a foreign loopback listener claim this port.
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
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
    let client: WebRuntimeClient | null = new WebRuntimeClient(
      pairedRuntimeConnectionFromOffer({
        v: 2,
        endpoint: `ws://127.0.0.1:${address.port}`,
        deviceToken: 'token',
        publicKeyB64: publicKeyToBase64(serverKeys.publicKey)
      })
    )
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
