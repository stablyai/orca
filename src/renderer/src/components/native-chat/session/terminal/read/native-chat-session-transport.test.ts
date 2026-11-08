import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

import {
  getNativeChatSessionTransport,
  RUNTIME_NATIVE_CHAT_RECONNECT_MS
} from './native-chat-session-transport'

const nativeChatReadSession = vi.fn()
const nativeChatSubscribe = vi.fn()
const runtimeEnvironmentsCall = vi.fn()
const runtimeEnvironmentsSubscribe = vi.fn()

const ENV = 'env-1'

/** Let the compatibility-gate await chain reach the runtime bridge. */

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.stubGlobal('window', {
    location: { pathname: '/index.html' },
    api: {
      nativeChat: { readSession: nativeChatReadSession, subscribe: nativeChatSubscribe },
      runtimeEnvironments: {
        call: runtimeEnvironmentsCall,
        subscribe: runtimeEnvironmentsSubscribe
      }
    }
  })
})

describe('runtime subscribe', () => {
  function stubSubscribe(): {
    unsubscribe: ReturnType<typeof vi.fn>
    deliver: (frame: unknown, ok?: boolean) => void
    drop: () => void
    subscribeCount: () => number
  } {
    const unsubscribe = vi.fn()
    let count = 0
    let onResponse: (r: { ok: boolean; result?: unknown }) => void = () => {}
    let onClose: () => void = () => {}
    runtimeEnvironmentsSubscribe.mockImplementation((_args, callbacks) => {
      count += 1
      onResponse = callbacks.onResponse
      onClose = callbacks.onClose ?? (() => {})
      return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
    })
    return {
      unsubscribe,
      deliver: (frame, ok = true) => onResponse(ok ? { ok: true, result: frame } : { ok: false }),
      drop: () => onClose(),
      subscribeCount: () => count
    }
  }

  it('re-subscribes after a mid-stream drop and stops reconnecting on teardown', async () => {
    vi.useFakeTimers()
    try {
      markRuntimeEnvironmentCompatible(ENV)
      const { drop, subscribeCount } = stubSubscribe()
      const transport = getNativeChatSessionTransport(ENV)

      const stop = transport.subscribe(
        { subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' },
        vi.fn()
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(subscribeCount()).toBe(1)

      drop() // runtime restart / socket dropped mid-stream
      await vi.advanceTimersByTimeAsync(RUNTIME_NATIVE_CHAT_RECONNECT_MS)
      expect(subscribeCount()).toBe(2)

      stop()
      drop() // a late close after teardown must not reconnect
      await vi.advanceTimersByTimeAsync(RUNTIME_NATIVE_CHAT_RECONNECT_MS)
      expect(subscribeCount()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps retrying when a reconnect subscribe rejects', async () => {
    vi.useFakeTimers()
    try {
      markRuntimeEnvironmentCompatible(ENV)
      const attempts: {
        callbacks: {
          onResponse: (response: { ok: boolean; result?: unknown }) => void
          onClose?: () => void
        }
        resolve: (handle: { unsubscribe: () => void; sendBinary: () => void }) => void
        reject: (error: Error) => void
      }[] = []
      runtimeEnvironmentsSubscribe.mockImplementation((_args, callbacks) => {
        return new Promise((resolve, reject) => attempts.push({ callbacks, resolve, reject }))
      })
      const transport = getNativeChatSessionTransport(ENV)

      transport.subscribe({ subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' }, vi.fn())
      attempts[0]!.resolve({ unsubscribe: vi.fn(), sendBinary: vi.fn() })
      attempts[0]!.callbacks.onResponse({
        ok: true,
        result: { type: 'snapshot', messages: [], hasMore: false }
      })
      attempts[0]!.callbacks.onClose?.()
      await vi.advanceTimersByTimeAsync(RUNTIME_NATIVE_CHAT_RECONNECT_MS)
      expect(attempts).toHaveLength(2)

      attempts[1]!.reject(new Error('reconnect failed'))
      await vi.advanceTimersByTimeAsync(RUNTIME_NATIVE_CHAT_RECONNECT_MS)

      expect(attempts).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes and retries when an established reconnect returns an error envelope', async () => {
    vi.useFakeTimers()
    try {
      markRuntimeEnvironmentCompatible(ENV)
      const attempts: {
        callbacks: {
          onResponse: (response: { ok: boolean; result?: unknown }) => void
          onClose?: () => void
        }
        unsubscribe: ReturnType<typeof vi.fn>
      }[] = []
      runtimeEnvironmentsSubscribe.mockImplementation((_args, callbacks) => {
        const unsubscribe = vi.fn()
        attempts.push({ callbacks, unsubscribe })
        return Promise.resolve({ unsubscribe, sendBinary: vi.fn() })
      })
      const transport = getNativeChatSessionTransport(ENV)

      transport.subscribe({ subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' }, vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      attempts[0]!.callbacks.onResponse({
        ok: true,
        result: { type: 'snapshot', messages: [], hasMore: false }
      })
      attempts[0]!.callbacks.onClose?.()
      await vi.advanceTimersByTimeAsync(RUNTIME_NATIVE_CHAT_RECONNECT_MS)
      expect(attempts).toHaveLength(2)

      attempts[1]!.callbacks.onResponse({ ok: false })
      attempts[1]!.callbacks.onClose?.()
      expect(attempts[1]!.unsubscribe).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(RUNTIME_NATIVE_CHAT_RECONNECT_MS)

      expect(attempts).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
