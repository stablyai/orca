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
      // Why: the connected-state liveness heartbeat arms a window.setInterval, so
      // the stub must provide interval timers once a client reaches 'connected'.
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

  it('rejects pending connection waiters when the client closes', async () => {
    vi.useFakeTimers()
    const timerWindow = window as unknown as {
      setTimeout: typeof setTimeout
      clearTimeout: typeof clearTimeout
    }
    timerWindow.setTimeout = setTimeout
    timerWindow.clearTimeout = clearTimeout
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })

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
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })

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
      vi.useRealTimers()
    }
  })

  it('keeps file watches on the owning WebSocket instead of opening child clients', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const handle = { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    const internals = client as unknown as {
      childClients: Set<WebRuntimeClient>
      subscribeOnCurrentConnection: WebRuntimeClient['subscribe']
    }
    const subscribeOnCurrentConnection = vi
      .spyOn(internals, 'subscribeOnCurrentConnection')
      .mockResolvedValue(handle)

    const subscription = await client.subscribe(
      'files.watch',
      { worktree: 'wt-1' },
      { onResponse: vi.fn() }
    )

    expect(subscribeOnCurrentConnection).toHaveBeenCalledWith(
      'files.watch',
      { worktree: 'wt-1' },
      expect.objectContaining({ onResponse: expect.any(Function) }),
      undefined
    )
    expect(internals.childClients.size).toBe(0)
    const frame = new Uint8Array([1])
    subscription.sendBinary(frame)
    expect(handle.sendBinary).toHaveBeenCalledWith(frame)
    client.close()
  })

  it('unwatches a direct file watch before removing the shared local subscription', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const localHandle = { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    const internals = client as unknown as {
      subscribeOnCurrentConnection: WebRuntimeClient['subscribe']
    }
    const subscribeOnCurrentConnection = vi
      .spyOn(internals, 'subscribeOnCurrentConnection')
      .mockResolvedValue(localHandle)
    const unwatch = vi.spyOn(client, 'call').mockImplementation(() => {
      expect(localHandle.unsubscribe).not.toHaveBeenCalled()
      return Promise.resolve({
        id: 'unwatch',
        ok: true,
        result: { unsubscribed: true },
        _meta: { runtimeId: 'runtime-web-test' }
      })
    })
    const onResponse = vi.fn()

    const subscription = await client.subscribe('files.watch', { worktree: 'wt-1' }, { onResponse })
    const wrappedCallbacks = subscribeOnCurrentConnection.mock.calls[0]?.[2]
    wrappedCallbacks?.onResponse({
      id: 'watch',
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId: 'files-watch-1' },
      _meta: { runtimeId: 'runtime-web-test' }
    } as RuntimeRpcResponse<unknown> & { streaming: true })

    subscription.unsubscribe()

    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(unwatch).toHaveBeenCalledWith(
      'files.unwatch',
      { subscriptionId: 'files-watch-1' },
      { timeoutMs: 5_000 }
    )
    await vi.waitFor(() => expect(localHandle.unsubscribe).toHaveBeenCalledTimes(1))
    client.close()
  })

  it('removes the shared local subscription when remote unwatch fails', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const localHandle = { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    const internals = client as unknown as {
      subscribeOnCurrentConnection: WebRuntimeClient['subscribe']
    }
    const subscribeOnCurrentConnection = vi
      .spyOn(internals, 'subscribeOnCurrentConnection')
      .mockResolvedValue(localHandle)
    const unwatchError = new Error('remote unwatch failed')
    const unwatch = vi.spyOn(client, 'call').mockRejectedValue(unwatchError)
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
      await vi.waitFor(() => expect(localHandle.unsubscribe).toHaveBeenCalledTimes(1))
      expect(warn).toHaveBeenCalledWith('Failed to unwatch remote file subscription:', unwatchError)
    } finally {
      client.close()
      warn.mockRestore()
    }
  })

  it('keeps a stopped direct file watch alive until ready so it can unwatch', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
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
    const onResponse = vi.fn()

    const subscription = await client.subscribe('files.watch', { worktree: 'wt-1' }, { onResponse })
    const wrappedCallbacks = subscribeOnCurrentConnection.mock.calls[0]?.[2]

    subscription.unsubscribe()
    expect(unwatch).not.toHaveBeenCalled()
    expect(localHandle.unsubscribe).not.toHaveBeenCalled()

    wrappedCallbacks?.onResponse({
      id: 'watch',
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId: 'files-watch-late' },
      _meta: { runtimeId: 'runtime-web-test' }
    } as RuntimeRpcResponse<unknown> & { streaming: true })

    expect(onResponse).not.toHaveBeenCalled()
    expect(unwatch).toHaveBeenCalledWith(
      'files.unwatch',
      { subscriptionId: 'files-watch-late' },
      { timeoutMs: 5_000 }
    )
    await vi.waitFor(() => expect(localHandle.unsubscribe).toHaveBeenCalledTimes(1))
    client.close()
  })

  it('cleans up a stopped pre-ready shared file watch if ready never arrives', async () => {
    vi.useFakeTimers()
    const timerWindow = window as unknown as {
      setTimeout: typeof setTimeout
      clearTimeout: typeof clearTimeout
    }
    timerWindow.setTimeout = setTimeout
    timerWindow.clearTimeout = clearTimeout
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const localHandle = { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    const internals = client as unknown as {
      subscribeOnCurrentConnection: WebRuntimeClient['subscribe']
    }
    vi.spyOn(internals, 'subscribeOnCurrentConnection').mockResolvedValue(localHandle)
    const unwatch = vi.spyOn(client, 'call')

    try {
      const subscription = await client.subscribe(
        'files.watch',
        { worktree: 'wt-1' },
        { onResponse: vi.fn() }
      )

      subscription.unsubscribe()
      expect(unwatch).not.toHaveBeenCalled()
      expect(localHandle.unsubscribe).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(4_999)
      expect(localHandle.unsubscribe).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(localHandle.unsubscribe).toHaveBeenCalledTimes(1)
      expect(unwatch).not.toHaveBeenCalled()
    } finally {
      client.close()
      vi.useRealTimers()
    }
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

  it('emits the buildUnsubscribe RPC frame on subscription teardown', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const internals = client as unknown as {
      waitForConnected: (timeoutMs?: number) => Promise<void>
      sendEncrypted: (message: unknown) => boolean
      subscribeOnCurrentConnection: (
        method: string,
        params: unknown,
        callbacks: unknown,
        options?: { buildUnsubscribe?: (params: unknown) => unknown }
      ) => Promise<{ unsubscribe: () => void }>
    }
    vi.spyOn(internals, 'waitForConnected').mockResolvedValue(undefined)
    const sent: unknown[] = []
    vi.spyOn(internals, 'sendEncrypted').mockImplementation((message) => {
      sent.push(message)
      return true
    })

    const handle = await internals.subscribeOnCurrentConnection(
      'nativeChat.subscribe',
      { agent: 'claude', sessionId: 'sess-1' },
      { onResponse: vi.fn() },
      {
        buildUnsubscribe: () => ({
          method: 'nativeChat.unsubscribe',
          params: { subscriptionId: 'claude:sess-1' }
        })
      }
    )

    handle.unsubscribe()

    const unsubscribeFrame = sent.find(
      (m) => (m as { method?: string }).method === 'nativeChat.unsubscribe'
    ) as { params: { subscriptionId: string } } | undefined
    expect(unsubscribeFrame?.params.subscriptionId).toBe('claude:sess-1')
    client.close()
  })
})
