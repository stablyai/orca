import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../../shared/e2ee-crypto'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import { WebRuntimeClient } from './web-runtime-client'

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

type ClientInternals = {
  ws: FakeWebSocket | null
  sharedKey: Uint8Array | null
  state: string
  subscriptions: Map<string, { needsReplay: boolean; pendingReplayTag: boolean }>
  subscribeOnCurrentConnection: WebRuntimeClient['subscribe']
  handleInterruptedSubscriptions(): void
  handleSocketMessage(rawData: unknown, sourceWs?: unknown): Promise<void>
  setState(next: string): void
}

function createConnectedClient(): {
  client: WebRuntimeClient
  internals: ClientInternals
  sharedKey: Uint8Array
} {
  const client = new WebRuntimeClient({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: Buffer.alloc(32).toString('base64')
  })
  fakeSockets[0]!.readyState = FakeWebSocket.OPEN
  const sharedKey = new Uint8Array(32)
  const internals = client as unknown as ClientInternals
  internals.sharedKey = sharedKey
  internals.state = 'connected'
  return { client, internals, sharedKey }
}

function reconnect(internals: ClientInternals, sharedKey: Uint8Array): FakeWebSocket {
  const replacementSocket = new FakeWebSocket('ws://127.0.0.1:6768')
  replacementSocket.readyState = FakeWebSocket.OPEN
  internals.ws = replacementSocket
  internals.sharedKey = sharedKey
  internals.setState('connected')
  return replacementSocket
}

describe('WebRuntimeClient retained subscription replay', () => {
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

  it.each(['session.tabs.subscribeAll', 'notifications.subscribe'])(
    'replays retained %s subscriptions and tags the first snapshot',
    async (method) => {
      const { client, internals, sharedKey } = createConnectedClient()
      const onResponse = vi.fn()
      const onClose = vi.fn()
      const onTransportInterrupted = vi.fn()
      const onTransportReplayed = vi.fn()
      const handle = await internals.subscribeOnCurrentConnection(
        method,
        {},
        { onResponse, onClose, onTransportInterrupted, onTransportReplayed }
      )
      const initialId = Array.from(internals.subscriptions.keys())[0]!

      internals.handleInterruptedSubscriptions()

      expect(onClose).not.toHaveBeenCalled()
      expect(onTransportInterrupted).toHaveBeenCalledOnce()
      expect(internals.subscriptions.get(initialId)?.needsReplay).toBe(true)

      const replacementSocket = reconnect(internals, sharedKey)
      const replacementId = Array.from(internals.subscriptions.keys())[0]!
      expect(replacementId).not.toBe(initialId)
      expect(onTransportReplayed).toHaveBeenCalledOnce()
      expect(internals.subscriptions.get(replacementId)?.pendingReplayTag).toBe(true)

      await internals.handleSocketMessage(
        encrypt(
          JSON.stringify({
            id: replacementId,
            ok: true,
            streaming: true,
            result: { type: 'snapshots', snapshots: [] },
            _meta: { runtimeId: 'runtime-after-serve-restart' }
          }),
          sharedKey
        ),
        replacementSocket
      )

      expect(onResponse).toHaveBeenCalledOnce()
      expect(isRuntimeSubscriptionReplayResponse(onResponse.mock.calls[0]?.[0])).toBe(true)
      expect(internals.subscriptions.get(replacementId)?.pendingReplayTag).toBe(false)

      handle.unsubscribe()
      client.close()
    }
  )

  it('closes a retained subscription when replay setup fails', async () => {
    const { client, internals, sharedKey } = createConnectedClient()
    const onResponse = vi.fn()
    const onClose = vi.fn()
    await internals.subscribeOnCurrentConnection(
      'session.tabs.subscribeAll',
      {},
      { onResponse, onClose }
    )
    internals.handleInterruptedSubscriptions()

    const replacementSocket = reconnect(internals, sharedKey)
    const replacementId = Array.from(internals.subscriptions.keys())[0]!
    await internals.handleSocketMessage(
      encrypt(
        JSON.stringify({
          id: replacementId,
          ok: false,
          error: { code: 'method_not_found', message: 'subscription unavailable' },
          _meta: { runtimeId: 'runtime-after-serve-restart' }
        }),
        sharedKey
      ),
      replacementSocket
    )

    expect(onResponse).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(internals.subscriptions.size).toBe(0)
    client.close()
  })
})
