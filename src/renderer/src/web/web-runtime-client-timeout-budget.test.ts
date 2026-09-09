import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebRuntimeClient } from './web-runtime-client'

class TimeoutBudgetWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = TimeoutBudgetWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()
}

describe('WebRuntimeClient timeout budget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', TimeoutBudgetWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts a fresh request timeout after the connection wait completes', async () => {
    const client = new WebRuntimeClient({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    client.close()
    let resolveConnection!: () => void
    const connection = new Promise<void>((resolve) => {
      resolveConnection = resolve
    })
    // Test seam: isolate call's connection and request phases from socket handshaking.
    // Both phases live on the transport the client delegates call() to.
    const internals = client as unknown as {
      transport: {
        connectionWaiters: { wait: (timeoutMs?: number) => Promise<void> }
        sendEncrypted: (message: unknown) => boolean
      }
    }
    const waitForConnected = vi.fn(() => connection)
    internals.transport.connectionWaiters.wait = waitForConnected
    internals.transport.sendEncrypted = vi.fn(() => true)

    const call = client.call('runtime.two-phase-timeout', undefined, { timeoutMs: 25 })
    let settled = false
    void call.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)
    expect(waitForConnected).toHaveBeenCalledWith(25)

    resolveConnection()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(24)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(call).rejects.toThrow('Request timed out: runtime.two-phase-timeout')
  })
})
