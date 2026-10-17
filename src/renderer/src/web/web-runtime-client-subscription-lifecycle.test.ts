import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './web-e2ee'

const sockets: SubscriptionSocket[] = []
const visibilityListeners = new Set<() => void>()

class SubscriptionSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = SubscriptionSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn(() => {
    this.readyState = 3
  })
  send = vi.fn<(data: string) => void>()

  constructor() {
    sockets.push(this)
  }

  authenticate(serverSecretKey: Uint8Array): Uint8Array {
    this.readyState = SubscriptionSocket.OPEN
    this.onopen?.()
    const hello: unknown = JSON.parse(this.send.mock.calls[0]![0])
    if (!hello || typeof hello !== 'object' || !('publicKeyB64' in hello)) {
      throw new Error('Expected encryption handshake')
    }
    if (typeof hello.publicKeyB64 !== 'string') {
      throw new Error('Expected client public key')
    }
    const sharedKey = deriveSharedKey(serverSecretKey, publicKeyFromBase64(hello.publicKeyB64))
    this.receive({ type: 'e2ee_authenticated' }, sharedKey)
    return sharedKey
  }

  receive(response: unknown, sharedKey: Uint8Array): void {
    this.onmessage?.({ data: encrypt(JSON.stringify(response), sharedKey) })
  }

  requestId(sharedKey: Uint8Array): string {
    const message = this.send.mock.calls.at(-1)?.[0]
    const plaintext = message ? decrypt(message, sharedKey) : null
    const request: unknown = plaintext ? JSON.parse(plaintext) : null
    if (!request || typeof request !== 'object' || !('id' in request)) {
      throw new Error('Expected subscription request')
    }
    if (typeof request.id !== 'string') {
      throw new Error('Expected subscription id')
    }
    return request.id
  }
}

function childClientCount(client: WebRuntimeClient): number {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WebRuntimeClient owns this private Set; inspect its retention without adding a production test API.
  return (client as unknown as { childClients: Set<WebRuntimeClient> }).childClients.size
}

describe('web subscription connection ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    visibilityListeners.clear()
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: (_event: string, listener: () => void) => visibilityListeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        visibilityListeners.delete(listener)
    })
    vi.stubGlobal('WebSocket', SubscriptionSocket)
  })

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0)
    expect(visibilityListeners.size).toBe(0)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('releases each rejected stream while preserving the owning connection', async () => {
    const serverKeys = generateKeyPair()
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: publicKeyToBase64(serverKeys.publicKey)
    })
    const ownerSocket = sockets[0]!
    ownerSocket.authenticate(serverKeys.secretKey)
    const baselineTimers = vi.getTimerCount()
    expect(baselineTimers).toBe(1)
    expect(visibilityListeners.size).toBe(1)

    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const onResponse = vi.fn()
        const onClose = vi.fn()
        const subscriptionPromise = client.subscribe(
          'nativeChat.subscribe',
          {},
          { onResponse, onClose }
        )
        const socket = sockets.at(-1)!
        const sharedKey = socket.authenticate(serverKeys.secretKey)
        await subscriptionPromise
        expect(childClientCount(client)).toBe(1)
        expect(vi.getTimerCount()).toBe(baselineTimers + 1)
        expect(visibilityListeners.size).toBe(2)

        const failure = {
          id: socket.requestId(sharedKey),
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown subscription' }
        }
        socket.receive(failure, sharedKey)
        await Promise.resolve()

        expect(onResponse).toHaveBeenCalledExactlyOnceWith(failure)
        expect(onClose).not.toHaveBeenCalled()
        expect(socket.close).toHaveBeenCalledTimes(1)
        expect(childClientCount(client)).toBe(0)
        expect(vi.getTimerCount()).toBe(baselineTimers)
        expect(visibilityListeners.size).toBe(1)
        expect(ownerSocket.close).not.toHaveBeenCalled()
      }

      const onResponse = vi.fn()
      const liveSubscription = client.subscribe('nativeChat.subscribe', {}, { onResponse })
      const liveSocket = sockets.at(-1)!
      const liveKey = liveSocket.authenticate(serverKeys.secretKey)
      const handle = await liveSubscription
      liveSocket.receive(
        {
          id: liveSocket.requestId(liveKey),
          ok: true,
          result: { type: 'snapshot', messages: [] },
          _meta: { runtimeId: 'runtime-test' }
        },
        liveKey
      )
      await Promise.resolve()
      expect(onResponse).toHaveBeenCalledTimes(1)
      expect(childClientCount(client)).toBe(1)
      expect(liveSocket.close).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(baselineTimers + 1)
      handle.unsubscribe()
      expect(childClientCount(client)).toBe(0)
      expect(vi.getTimerCount()).toBe(baselineTimers)
    } finally {
      client.close()
    }
  })
})
