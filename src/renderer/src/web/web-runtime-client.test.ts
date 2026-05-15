import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readonly readyState = FakeWebSocket.CONNECTING
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
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary')
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
        childClients: Set<{ close: () => void }>
      }
    ).childClients.add(child)

    client.close()

    expect(child.close).toHaveBeenCalledTimes(1)
  })
})
