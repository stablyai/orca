import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRemoteRuntimeTerminalMultiplexersForTests } from './registry/remote-runtime-terminal-multiplexer-registry'
import { subscribeToRuntimeTerminalData } from './runtime-terminal-data-subscription'

import { stubRuntimeEnvironmentBridge } from '../../rpc/testing/runtime-environment-bridge-fixture'

describe('remote runtime terminal data subscriptions', () => {
  const runtimeSubscribe = vi.fn()
  const sendBinary = vi.fn()
  const unsubscribe = vi.fn()
  let callbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { message: string }) => void
    onClose?: () => void
  } | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeTerminalMultiplexersForTests()
    callbacks = null
    runtimeSubscribe.mockImplementation(async (_args: unknown, nextCallbacks: typeof callbacks) => {
      callbacks = nextCallbacks
      queueMicrotask(() =>
        callbacks?.onResponse({
          ok: true,
          result: { type: 'ready' }
        })
      )
      return { unsubscribe, sendBinary }
    })
    stubRuntimeEnvironmentBridge({ subscribe: runtimeSubscribe })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unsubscribes a late subscription handle after pre-resolution transport close', async () => {
    let resolveSubscribe!: (handle: {
      unsubscribe: () => void
      sendBinary: typeof sendBinary
    }) => void
    runtimeSubscribe.mockImplementationOnce((_args: unknown, nextCallbacks: typeof callbacks) => {
      callbacks = nextCallbacks
      callbacks?.onClose?.()
      return new Promise((resolve) => {
        resolveSubscribe = resolve
      })
    })

    const subscriptionPromise = subscribeToRuntimeTerminalData(
      'remote:env-1@@terminal-1',
      'watcher-1',
      vi.fn()
    )

    await expect(subscriptionPromise).rejects.toThrow('Remote Orca runtime closed the connection.')

    resolveSubscribe({ unsubscribe, sendBinary })
    await Promise.resolve()

    expect(unsubscribe).toHaveBeenCalled()
  })
})
