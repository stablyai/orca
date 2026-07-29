// Regression tests for the reconnect-gap resync of replayed paired-web file
// watches: a replayed files.watch reports changes only from its own native
// setup, so consumers must receive a conservative overflow once it is ready.
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'
import { encrypt } from '../../../shared/e2ee-crypto'

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

describe('WebRuntimeClient file-watch replay resync', () => {
  beforeEach(() => {
    fakeSockets.length = 0
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
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

  it('delivers a conservative overflow after a replayed file watch is ready', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    const initialSocket = fakeSockets[0]!
    initialSocket.readyState = FakeWebSocket.OPEN
    const onResponse = vi.fn()
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
    }
    internals.sharedKey = new Uint8Array(32)
    internals.state = 'connected'

    await client.subscribe('files.watch', { worktree: 'wt-1' }, { onResponse })
    const [firstId, first] = Array.from(internals.subscriptions.entries())[0]!
    first.callbacks.onResponse({
      id: firstId,
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId: 'sub-1' },
      _meta: { runtimeId: 'runtime-web-test' }
    })
    // Why: an initial ready is not a replay — consumers already scan on setup.
    expect(onResponse).toHaveBeenCalledTimes(1)

    initialSocket.onclose?.()
    const replacementSocket = new FakeWebSocket('ws://127.0.0.1:6768')
    replacementSocket.readyState = FakeWebSocket.OPEN
    internals.ws = replacementSocket
    internals.sharedKey = new Uint8Array(32)
    internals.setState('connected')

    const [replacementId, replacement] = Array.from(internals.subscriptions.entries())[0]!
    replacement.callbacks.onResponse({
      id: replacementId,
      ok: true,
      streaming: true,
      result: { type: 'ready', subscriptionId: 'sub-2' },
      _meta: { runtimeId: 'runtime-web-test' }
    })

    // Why: changes during the reconnect gap produced no watch events, so the
    // replayed watch must be followed by an overflow that forces a re-scan.
    expect(onResponse).toHaveBeenCalledTimes(3)
    expect(onResponse.mock.calls[2]![0]).toMatchObject({
      ok: true,
      result: {
        type: 'changed',
        worktree: 'wt-1',
        events: [{ kind: 'overflow' }]
      }
    })
    client.close()
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
})
