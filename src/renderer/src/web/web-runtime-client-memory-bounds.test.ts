import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WEB_RUNTIME_MAX_BINARY_FRAME_BYTES,
  WEB_RUNTIME_MAX_CHILD_CLIENTS,
  WEB_RUNTIME_MAX_CONNECTION_WAITERS,
  WEB_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  WEB_RUNTIME_MAX_PENDING_REQUESTS,
  WEB_RUNTIME_MAX_RPC_METHOD_BYTES,
  WEB_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES,
  WEB_RUNTIME_MAX_SUBSCRIPTIONS,
  WebRuntimeClient
} from './web-runtime-client'
import { createWebRuntimeOutboundMemoryBudget } from './web-runtime-outbound-memory-budget'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = FakeWebSocket.CONNECTING
  bufferedAmount = 0
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()
}

function createClient(): WebRuntimeClient {
  return new WebRuntimeClient({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: Buffer.alloc(32).toString('base64')
  })
}

function acceptedOutboundSend(): { accepted: true; queued: false; cancel: () => false } {
  return { accepted: true, queued: false, cancel: () => false }
}

describe('WebRuntimeClient memory admission', () => {
  beforeEach(() => {
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

  it('rejects connection fan-out after the waiter cap', async () => {
    const client = createClient()
    const waiting = Array.from({ length: WEB_RUNTIME_MAX_CONNECTION_WAITERS }, () =>
      client.call('status.get').catch((error: unknown) => error)
    )

    await expect(client.call('status.get')).rejects.toThrow('client is busy')

    client.close()
    await Promise.all(waiting)
  })

  it('rejects request fan-out after the connected pending cap', async () => {
    const client = createClient()
    const internals = client as unknown as {
      state: string
      sendEncryptedSerialized: (serialized: string) => ReturnType<typeof acceptedOutboundSend>
      pending: Map<string, unknown>
    }
    internals.state = 'connected'
    vi.spyOn(internals, 'sendEncryptedSerialized').mockReturnValue(acceptedOutboundSend())
    const pending = Array.from({ length: WEB_RUNTIME_MAX_PENDING_REQUESTS }, () =>
      client.call('status.get').catch((error: unknown) => error)
    )
    await vi.waitFor(() => expect(internals.pending.size).toBe(WEB_RUNTIME_MAX_PENDING_REQUESTS))

    await expect(client.call('status.get')).rejects.toThrow('client is busy')

    client.close()
    await Promise.all(pending)
  })

  it('caps active subscription records and child sockets', async () => {
    const client = createClient()
    const internals = client as unknown as {
      state: string
      subscriptions: Map<string, unknown>
      childClients: Set<{ close: () => void }>
      subscribeOnCurrentConnection: (
        method: string,
        params: unknown,
        callbacks: { onResponse: () => void }
      ) => Promise<unknown>
    }
    internals.state = 'connected'
    for (let index = 0; index < WEB_RUNTIME_MAX_SUBSCRIPTIONS; index++) {
      internals.subscriptions.set(`subscription-${index}`, {})
    }

    await expect(
      internals.subscribeOnCurrentConnection('files.watch', {}, { onResponse: vi.fn() })
    ).rejects.toThrow('client is busy')

    internals.subscriptions.clear()
    for (let index = 0; index < WEB_RUNTIME_MAX_CHILD_CLIENTS; index++) {
      internals.childClients.add({ close: vi.fn() })
    }
    await expect(
      client.subscribe('terminal.multiplex', {}, { onResponse: vi.fn() })
    ).rejects.toThrow('client is busy')

    client.close()
  })

  it('rejects an oversized Blob before copying it into an ArrayBuffer', async () => {
    const client = createClient()
    const onBinary = vi.fn()
    const arrayBuffer = vi.fn()
    const oversizedBlob = Object.create(Blob.prototype) as Blob
    Object.defineProperties(oversizedBlob, {
      size: { value: WEB_RUNTIME_MAX_BINARY_FRAME_BYTES + 1 },
      arrayBuffer: { value: arrayBuffer }
    })
    const internals = client as unknown as {
      state: string
      sharedKey: Uint8Array
      subscriptions: Map<string, { callbacks: { onBinary: typeof onBinary } }>
      handleSocketMessage: (rawData: unknown) => Promise<void>
    }
    internals.state = 'connected'
    internals.sharedKey = new Uint8Array(32)
    internals.subscriptions.set('stream-1', { callbacks: { onBinary } })

    await internals.handleSocketMessage(oversizedBlob)

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(onBinary).not.toHaveBeenCalled()
    client.close()
  })

  it('bounds RPC method keys before they enter connection waiters', async () => {
    const client = createClient()
    const internals = client as unknown as { waiters: unknown[] }

    await expect(client.call('x'.repeat(WEB_RUNTIME_MAX_RPC_METHOD_BYTES + 1))).rejects.toThrow(
      'RPC method exceeds'
    )
    expect(internals.waiters).toHaveLength(0)
    client.close()
  })

  it('accepts exact subscription parameters and releases their retained bytes', async () => {
    const client = createClient()
    const internals = client as unknown as {
      state: string
      sendEncryptedSerialized: (serialized: string) => ReturnType<typeof acceptedOutboundSend>
      subscriptions: Map<string, unknown>
      subscribeOnCurrentConnection: (
        method: string,
        params: unknown,
        callbacks: { onResponse: () => void }
      ) => Promise<{ unsubscribe: () => void }>
    }
    internals.state = 'connected'
    vi.spyOn(internals, 'sendEncryptedSerialized').mockReturnValue(acceptedOutboundSend())
    const handle = await internals.subscribeOnCurrentConnection(
      'files.watch',
      'x'.repeat(WEB_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES - 2),
      { onResponse: vi.fn() }
    )

    expect(internals.subscriptions.size).toBe(1)
    handle.unsubscribe()
    expect(internals.subscriptions.size).toBe(0)
    await expect(
      internals.subscribeOnCurrentConnection(
        'files.watch',
        'x'.repeat(WEB_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES - 1),
        { onResponse: vi.fn() }
      )
    ).rejects.toThrow('JSON payload exceeds')
    expect(internals.subscriptions.size).toBe(0)
    client.close()
  })

  it('does not retain a subscription when parameter serialization throws', async () => {
    const client = createClient()
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const internals = client as unknown as {
      subscriptions: Map<string, unknown>
      subscribeOnCurrentConnection: (
        method: string,
        params: unknown,
        callbacks: { onResponse: () => void }
      ) => Promise<unknown>
    }

    await expect(
      internals.subscribeOnCurrentConnection('files.watch', cyclic, { onResponse: vi.fn() })
    ).rejects.toThrow('circular')
    expect(internals.subscriptions.size).toBe(0)
    client.close()
  })

  it('releases a subscription when encryption fails after admission', async () => {
    const client = createClient()
    const internals = client as unknown as {
      state: string
      sharedKey: Uint8Array
      ws: FakeWebSocket
      subscriptions: Map<string, unknown>
      subscribeOnCurrentConnection: (
        method: string,
        params: unknown,
        callbacks: { onResponse: () => void }
      ) => Promise<unknown>
    }
    internals.state = 'connected'
    internals.sharedKey = new Uint8Array(32)
    internals.ws.readyState = FakeWebSocket.OPEN
    const runtimeWindow = window as unknown as { btoa: (value: string) => string }
    runtimeWindow.btoa = () => {
      throw new Error('encryption allocation failed')
    }

    await expect(
      internals.subscribeOnCurrentConnection('files.watch', {}, { onResponse: vi.fn() })
    ).rejects.toThrow('could not send the subscription')
    expect(internals.subscriptions.size).toBe(0)
    client.close()
  })

  it('closes an overloaded socket after the aggregate queued-frame cap', () => {
    const budget = createWebRuntimeOutboundMemoryBudget({
      maxBufferedBytes: 1,
      maxQueuedBytes: 1_024,
      maxQueuedFrames: 2
    })
    const client = new WebRuntimeClient(
      {
        v: 2,
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: Buffer.alloc(32).toString('base64')
      },
      budget
    )
    const internals = client as unknown as {
      state: string
      sharedKey: Uint8Array
      ws: FakeWebSocket
      sendEncrypted: (message: unknown) => boolean
    }
    internals.state = 'connected'
    internals.sharedKey = new Uint8Array(32)
    internals.ws.readyState = FakeWebSocket.OPEN
    internals.ws.bufferedAmount = 1

    expect(internals.sendEncrypted({ value: 1 })).toBe(true)
    expect(internals.sendEncrypted({ value: 2 })).toBe(true)
    expect(internals.sendEncrypted({ value: 3 })).toBe(false)
    expect(internals.ws).toBeNull()
  })

  it('closes before encrypting an oversized outbound binary frame', () => {
    const client = createClient()
    const internals = client as unknown as {
      ws: FakeWebSocket | null
      sendEncryptedBinary: (bytes: Uint8Array) => boolean
    }
    const socket = internals.ws!
    socket.readyState = FakeWebSocket.OPEN
    const oversized = {
      byteLength: WEB_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 1
    } as Uint8Array

    expect(internals.sendEncryptedBinary(oversized)).toBe(false)
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(internals.ws).toBeNull()
  })
})
