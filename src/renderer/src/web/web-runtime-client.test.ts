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
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import '../../../shared/protocol-version'

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

  it('ignores messages from a stale socket after reconnect creates a replacement', async () => {
    vi.useFakeTimers()
    const timerWindow = window as unknown as {
      setTimeout: typeof setTimeout
      clearTimeout: typeof clearTimeout
    }
    timerWindow.setTimeout = setTimeout
    timerWindow.clearTimeout = clearTimeout
    // Pin the one-sided reconnect jitter to zero so the redial lands on its exact backoff step.
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
      const staleSocket = fakeSockets[0]!

      await vi.advanceTimersByTimeAsync(12_000)
      await vi.advanceTimersByTimeAsync(500)

      const replacementSocket = fakeSockets[1]!
      replacementSocket.readyState = FakeWebSocket.OPEN
      replacementSocket.onopen?.()

      expect(replacementSocket.send).toHaveBeenCalledTimes(1)

      staleSocket.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
      await Promise.resolve()

      expect(replacementSocket.send).toHaveBeenCalledTimes(1)
    } finally {
      client.close()
      random.mockRestore()
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

  it('retains and retries a shared local subscription when remote unwatch returns failure', async () => {
    const client = new WebRuntimeClient(
      pairedRuntimeConnectionFromOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: Buffer.alloc(32).toString('base64')
      })
    )
    const localHandle = { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    const internals = client as unknown as {
      subscribeOnCurrentConnection: WebRuntimeClient['subscribe']
    }
    const subscribeOnCurrentConnection = vi
      .spyOn(internals, 'subscribeOnCurrentConnection')
      .mockResolvedValue(localHandle)
    const unwatch = vi
      .spyOn(client, 'call')
      .mockResolvedValueOnce({
        id: 'unwatch-failed',
        ok: false,
        error: { code: 'teardown_failed', message: 'remote unwatch failed' }
      })
      .mockResolvedValueOnce({
        id: 'unwatch-retry',
        ok: true,
        result: { unsubscribed: true },
        _meta: { runtimeId: 'runtime-web-test' }
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const subscription = await client.subscribe(
        'files.watch',
        { worktree: 'wt-1' },
        { onResponse: vi.fn() }
      )
      const wrappedCallbacks = subscribeOnCurrentConnection.mock.calls[0]?.[2]
      wrappedCallbacks?.onResponse({
        id: 'watch',
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: 'files-watch-failing-unwatch' },
        _meta: { runtimeId: 'runtime-web-test' }
      } as RuntimeRpcResponse<unknown> & { streaming: true })

      subscription.unsubscribe()

      expect(unwatch).toHaveBeenCalledWith(
        'files.unwatch',
        { subscriptionId: 'files-watch-failing-unwatch' },
        { timeoutMs: 5_000 }
      )
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
      expect(localHandle.unsubscribe).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        'Failed to unwatch remote file subscription:',
        expect.objectContaining({ message: 'teardown_failed: remote unwatch failed' })
      )

      await client.subscribe('files.watch', { worktree: 'wt-1' }, { onResponse: vi.fn() })
      expect(unwatch).toHaveBeenCalledTimes(2)
      expect(localHandle.unsubscribe).toHaveBeenCalledTimes(1)
      expect(subscribeOnCurrentConnection).toHaveBeenCalledTimes(2)
    } finally {
      client.close()
      warn.mockRestore()
    }
  })

  it('retries every failed same-root teardown before opening a replacement watch', async () => {
    const client = new WebRuntimeClient(
      pairedRuntimeConnectionFromOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: Buffer.alloc(32).toString('base64')
      })
    )
    const handles = Array.from({ length: 3 }, () => ({
      unsubscribe: vi.fn(),
      sendBinary: vi.fn()
    }))
    const internals = client as unknown as {
      subscribeOnCurrentConnection: WebRuntimeClient['subscribe']
    }
    const subscribeOnCurrentConnection = vi
      .spyOn(internals, 'subscribeOnCurrentConnection')
      .mockResolvedValueOnce(handles[0])
      .mockResolvedValueOnce(handles[1])
      .mockResolvedValueOnce(handles[2])
    const unwatch = vi
      .spyOn(client, 'call')
      .mockRejectedValueOnce(new Error('first teardown failed'))
      .mockRejectedValueOnce(new Error('second teardown failed'))
      .mockResolvedValue({
        id: 'unwatch-retry',
        ok: true,
        result: { unsubscribed: true },
        _meta: { runtimeId: 'runtime-web-test' }
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first = await client.subscribe(
        'files.watch',
        { worktree: 'wt-1' },
        { onResponse: vi.fn() }
      )
      const second = await client.subscribe(
        'files.watch',
        { worktree: 'wt-1' },
        { onResponse: vi.fn() }
      )
      for (const [index, subscriptionId] of ['watch-a', 'watch-b'].entries()) {
        subscribeOnCurrentConnection.mock.calls[index]?.[2].onResponse({
          id: subscriptionId,
          ok: true,
          streaming: true,
          result: { type: 'ready', subscriptionId },
          _meta: { runtimeId: 'runtime-web-test' }
        } as RuntimeRpcResponse<unknown> & { streaming: true })
      }
      first.unsubscribe()
      second.unsubscribe()
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))

      await client.subscribe('files.watch', { worktree: 'wt-1' }, { onResponse: vi.fn() })

      expect(unwatch).toHaveBeenCalledTimes(4)
      expect(handles[0].unsubscribe).toHaveBeenCalledTimes(1)
      expect(handles[1].unsubscribe).toHaveBeenCalledTimes(1)
      expect(subscribeOnCurrentConnection).toHaveBeenCalledTimes(3)
    } finally {
      client.close()
      warn.mockRestore()
    }
  })

  it('retains a stopped pre-ready file watch until its cancellation id arrives', async () => {
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
    const localHandle = { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    const internals = client as unknown as {
      subscribeOnCurrentConnection: WebRuntimeClient['subscribe']
    }
    const subscribeOnCurrentConnection = vi
      .spyOn(internals, 'subscribeOnCurrentConnection')
      .mockResolvedValue(localHandle)
    const unwatch = vi.spyOn(client, 'call').mockResolvedValue({
      id: 'unwatch',
      ok: true,
      result: { unsubscribed: true },
      _meta: { runtimeId: 'runtime-web-test' }
    })

    try {
      const subscription = await client.subscribe(
        'files.watch',
        { worktree: 'wt-1' },
        { onResponse: vi.fn() }
      )

      subscription.unsubscribe()
      expect(unwatch).not.toHaveBeenCalled()
      expect(localHandle.unsubscribe).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(300_000)
      expect(localHandle.unsubscribe).not.toHaveBeenCalled()

      const wrappedCallbacks = subscribeOnCurrentConnection.mock.calls[0]?.[2]
      wrappedCallbacks?.onResponse({
        id: 'watch',
        ok: true,
        streaming: true,
        result: { type: 'starting', subscriptionId: 'files-watch-pending' },
        _meta: { runtimeId: 'runtime-web-test' }
      } as RuntimeRpcResponse<unknown> & { streaming: true })

      expect(unwatch).toHaveBeenCalledWith(
        'files.unwatch',
        { subscriptionId: 'files-watch-pending' },
        { timeoutMs: 5_000 }
      )
      await vi.waitFor(() => expect(localHandle.unsubscribe).toHaveBeenCalledTimes(1))
    } finally {
      client.close()
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
