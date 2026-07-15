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

  it('replays an active file watch on reconnect and keeps its logical handle', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const initialSocket = fakeSockets[0]!
    initialSocket.readyState = FakeWebSocket.OPEN
    const onResponse = vi.fn()
    const onClose = vi.fn()
    const internals = client as unknown as {
      ws: FakeWebSocket | null
      sharedKey: Uint8Array | null
      state: string
      subscriptions: Map<
        string,
        {
          callbacks: { onResponse: typeof onResponse }
          needsReplay: boolean
        }
      >
      setState(next: string): void
      handleSocketClosed(socket: FakeWebSocket): void
    }
    internals.sharedKey = new Uint8Array(32)
    internals.state = 'connected'

    const handle = await client.subscribe(
      'files.watch',
      { worktree: 'wt-1' },
      { onResponse, onClose }
    )
    const firstId = Array.from(internals.subscriptions.keys())[0]
    expect(initialSocket.send).toHaveBeenCalledTimes(1)

    initialSocket.onclose?.()

    expect(onClose).not.toHaveBeenCalled()
    expect(internals.subscriptions.get(firstId!)?.needsReplay).toBe(true)

    const replacementSocket = new FakeWebSocket('ws://127.0.0.1:6768')
    replacementSocket.readyState = FakeWebSocket.OPEN
    internals.ws = replacementSocket
    internals.sharedKey = new Uint8Array(32)
    internals.setState('connected')

    const [replacementId, replacement] = Array.from(internals.subscriptions.entries())[0]!
    expect(replacementId).not.toBe(firstId)
    expect(replacementSocket.send).toHaveBeenCalledTimes(1)
    replacement.callbacks.onResponse({
      id: replacementId,
      ok: true,
      streaming: true,
      result: { type: 'changed', worktree: 'wt-1', events: [] },
      _meta: { runtimeId: 'runtime-web-test' }
    })
    expect(onResponse).toHaveBeenCalledTimes(1)

    handle.unsubscribe()
    internals.handleSocketClosed(replacementSocket)
    expect(internals.subscriptions.size).toBe(0)
    const secondReplacementSocket = new FakeWebSocket('ws://127.0.0.1:6768')
    secondReplacementSocket.readyState = FakeWebSocket.OPEN
    internals.ws = secondReplacementSocket
    internals.sharedKey = new Uint8Array(32)
    internals.setState('connected')
    expect(secondReplacementSocket.send).not.toHaveBeenCalled()
    client.close()
    expect(internals.subscriptions.size).toBe(0)
  })

  it('does not replay a file watch stopped after its socket disconnects', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const initialSocket = fakeSockets[0]!
    initialSocket.readyState = FakeWebSocket.OPEN
    const internals = client as unknown as {
      ws: FakeWebSocket | null
      sharedKey: Uint8Array | null
      state: string
      subscriptions: Map<string, { needsReplay: boolean }>
      setState(next: string): void
    }
    internals.sharedKey = new Uint8Array(32)
    internals.state = 'connected'
    const handle = await client.subscribe(
      'files.watch',
      { worktree: 'wt-1' },
      { onResponse: vi.fn() }
    )

    initialSocket.onclose?.()
    expect(Array.from(internals.subscriptions.values())[0]?.needsReplay).toBe(true)
    handle.unsubscribe()
    expect(internals.subscriptions.size).toBe(0)

    const replacementSocket = new FakeWebSocket('ws://127.0.0.1:6768')
    replacementSocket.readyState = FakeWebSocket.OPEN
    internals.ws = replacementSocket
    internals.sharedKey = new Uint8Array(32)
    internals.setState('connected')
    expect(replacementSocket.send).not.toHaveBeenCalled()
    client.close()
  })

  it('evicts a failed file-watch setup before reconnect can replay it', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const initialSocket = fakeSockets[0]!
    initialSocket.readyState = FakeWebSocket.OPEN
    const sharedKey = new Uint8Array(32)
    const onResponse = vi.fn()
    const internals = client as unknown as {
      ws: FakeWebSocket | null
      sharedKey: Uint8Array | null
      state: string
      subscriptions: Map<string, unknown>
      handleSocketMessage(rawData: unknown): Promise<void>
      setState(next: string): void
    }
    internals.sharedKey = sharedKey
    internals.state = 'connected'
    await client.subscribe('files.watch', { worktree: 'wt-1' }, { onResponse })
    const subscriptionId = Array.from(internals.subscriptions.keys())[0]!

    await internals.handleSocketMessage(
      encrypt(
        JSON.stringify({
          id: subscriptionId,
          ok: false,
          error: { code: 'watch_failed', message: 'root unavailable' }
        }),
        sharedKey
      )
    )

    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(internals.subscriptions.size).toBe(0)
    initialSocket.onclose?.()
    const replacementSocket = new FakeWebSocket('ws://127.0.0.1:6768')
    replacementSocket.readyState = FakeWebSocket.OPEN
    internals.ws = replacementSocket
    internals.sharedKey = sharedKey
    internals.setState('connected')
    expect(replacementSocket.send).not.toHaveBeenCalled()
    client.close()
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
    const onResponse = vi.fn()

    const subscription = await client.subscribe('files.watch', { worktree: 'wt-1' }, { onResponse })

    expect(subscribeOnCurrentConnection).toHaveBeenCalledWith(
      'files.watch',
      { worktree: 'wt-1' },
      expect.objectContaining({ onResponse: expect.any(Function) }),
      undefined
    )
    expect(internals.childClients.size).toBe(0)
    subscribeOnCurrentConnection.mock.calls[0]?.[2].onResponse({
      id: 'watch',
      ok: true,
      streaming: true,
      result: { type: 'starting', subscriptionId: 'files-watch-starting' },
      _meta: { runtimeId: 'runtime-web-test' }
    } as RuntimeRpcResponse<unknown> & { streaming: true })
    expect(onResponse).not.toHaveBeenCalled()
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

  it('retains and retries a shared local subscription when remote unwatch returns failure', async () => {
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
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
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

  it('retains a stopped pre-ready file watch until its cancellation id arrives', async () => {
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
