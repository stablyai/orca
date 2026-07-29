import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests
} from './remote-runtime-terminal-multiplexer'

type MultiplexCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

const streamCallbacks = () => ({
  onData: vi.fn(),
  onSnapshot: vi.fn()
})

function timeoutError(): Error {
  return Object.assign(
    new Error('Timed out waiting for the remote Orca runtime subscription to start.'),
    { code: 'runtime_timeout' }
  )
}

describe('remote runtime terminal multiplexer connection deadlines', () => {
  const runtimeSubscribe = vi.fn()
  const sendBinary = vi.fn()
  const unsubscribe = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  afterEach(() => {
    resetRemoteRuntimeTerminalMultiplexersForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('times out a recovery subscriber without cancelling a default handshake', async () => {
    let callbacks: MultiplexCallbacks | null = null
    let resolveSubscribe: (handle: {
      unsubscribe: () => void
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
    }) => void = () => {}
    runtimeSubscribe.mockImplementation((_args: unknown, nextCallbacks: MultiplexCallbacks) => {
      callbacks = nextCallbacks
      return new Promise((resolve) => {
        resolveSubscribe = resolve
      })
    })
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-default-first')
    const defaultSubscription = multiplexer.subscribeTerminal({
      terminal: 'terminal-default',
      client: { id: 'desktop-default', type: 'desktop' },
      callbacks: streamCallbacks()
    })
    const recoverySubscription = multiplexer.subscribeTerminal({
      terminal: 'terminal-recovery',
      client: { id: 'desktop-recovery', type: 'desktop' },
      connectionTimeoutMs: 5_000,
      callbacks: streamCallbacks()
    })
    const recoveryTimeout = expect(recoverySubscription).rejects.toMatchObject({
      code: 'runtime_timeout'
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await recoveryTimeout
    expect(runtimeSubscribe).toHaveBeenCalledOnce()
    expect(runtimeSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 15_000 }),
      expect.any(Object)
    )

    resolveSubscribe({ unsubscribe, sendBinary })
    ;(callbacks as MultiplexCallbacks | null)?.onResponse({
      ok: true,
      result: { type: 'ready' }
    })
    const defaultStream = await defaultSubscription

    defaultStream.close()
  })

  it('lets a default subscriber continue after a recovery handshake times out', async () => {
    const connectionTimeouts: number[] = []
    runtimeSubscribe.mockImplementation(
      (args: { timeoutMs: number }, callbacks: MultiplexCallbacks) => {
        connectionTimeouts.push(args.timeoutMs)
        if (connectionTimeouts.length === 1) {
          return new Promise((_, reject) => {
            setTimeout(() => reject(timeoutError()), args.timeoutMs)
          })
        }
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return Promise.resolve({ unsubscribe, sendBinary })
      }
    )
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-recovery-first')
    const recoverySubscription = multiplexer.subscribeTerminal({
      terminal: 'terminal-recovery',
      client: { id: 'desktop-recovery', type: 'desktop' },
      connectionTimeoutMs: 5_000,
      callbacks: streamCallbacks()
    })
    const defaultSubscription = multiplexer.subscribeTerminal({
      terminal: 'terminal-default',
      client: { id: 'desktop-default', type: 'desktop' },
      callbacks: streamCallbacks()
    })
    const recoveryTimeout = expect(recoverySubscription).rejects.toMatchObject({
      code: 'runtime_timeout'
    })

    await vi.advanceTimersByTimeAsync(5_000)
    await recoveryTimeout
    const defaultStream = await defaultSubscription

    expect(connectionTimeouts).toEqual([5_000, 10_000])
    defaultStream.close()
  })
})
