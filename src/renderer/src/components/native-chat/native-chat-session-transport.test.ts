import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible,
  RuntimeRpcCallError
} from '@/runtime/runtime-rpc-client'
import { RUNTIME_COMPAT_BLOCK_CODE } from '@/runtime/runtime-protocol-compat'
import {
  getNativeChatSessionTransport,
  RUNTIME_NATIVE_CHAT_RECONNECT_MS,
  toRuntimeNativeChatErrorMessage
} from './native-chat-session-transport'

const nativeChatReadSession = vi.fn()
const nativeChatSubscribe = vi.fn()
const runtimeEnvironmentsCall = vi.fn()
const runtimeEnvironmentsSubscribe = vi.fn()

const ENV = 'env-1'

function message(id: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text: id }], timestamp: 1, source: 'transcript' }
}

function okEnvelope(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result }
}

/** Flush pending microtasks and a macrotask turn — enough for the compat-gate
 *  await chain inside callRuntimeRpc to reach window.api.runtimeEnvironments.call. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve))
}

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

describe('getNativeChatSessionTransport — selection', () => {
  it('returns the local adapter for a null owner and forwards readSession args', async () => {
    nativeChatReadSession.mockResolvedValue({ messages: [] })
    const transport = getNativeChatSessionTransport(null)

    await transport.readSession('claude', 'sess-1', 40, '/t/path')

    expect(nativeChatReadSession).toHaveBeenCalledWith('claude', 'sess-1', 40, '/t/path')
    expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
  })

  it('returns the runtime adapter for an owner on the desktop client', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    runtimeEnvironmentsCall.mockResolvedValue(okEnvelope({ messages: [] }))
    const transport = getNativeChatSessionTransport(ENV)

    await transport.readSession('claude', 'sess-1', 40, '/t/path')

    expect(runtimeEnvironmentsCall).toHaveBeenCalledWith({
      selector: ENV,
      method: 'nativeChat.readSession',
      params: { agent: 'claude', sessionId: 'sess-1', limit: 40, transcriptPath: '/t/path' },
      timeoutMs: 15_000
    })
    expect(nativeChatReadSession).not.toHaveBeenCalled()
  })

  it('returns the local adapter on the web client even with an owner (R3 guard)', async () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    nativeChatReadSession.mockResolvedValue({ messages: [] })
    const transport = getNativeChatSessionTransport(ENV)

    await transport.readSession('claude', 'sess-1', 40, undefined)

    expect(nativeChatReadSession).toHaveBeenCalledOnce()
    expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
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

  it('forwards only appended frames with an array of messages', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onAppended = vi.fn()
    const transport = getNativeChatSessionTransport(ENV)

    transport.subscribe({ subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' }, onAppended)
    await Promise.resolve()

    deliver({ type: 'appended', messages: [message('m-1')] })
    deliver({ type: 'ready' }) // non-appended, ignored
    deliver({ type: 'appended', messages: undefined }) // no array, ignored
    deliver({ type: 'appended', messages: [message('m-2')] }, false) // !ok, ignored

    expect(onAppended).toHaveBeenCalledTimes(1)
    expect(onAppended).toHaveBeenCalledWith([message('m-1')])
  })

  it('sync unsubscribe closes the dedicated stream and issues no unsubscribe RPC (KTD-6)', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const { unsubscribe } = stubSubscribe()
    const transport = getNativeChatSessionTransport(ENV)

    const stop = transport.subscribe(
      { subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' },
      vi.fn()
    )
    await flush()
    stop()
    await flush()

    expect(unsubscribe).toHaveBeenCalledOnce()
    // The runtime reaps the fs-watcher when the dedicated stream socket closes, so
    // no nativeChat.unsubscribe RPC is sent — one would ride a different connection
    // and never match the watcher's cleanup key.
    expect(runtimeEnvironmentsCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'nativeChat.unsubscribe' })
    )
  })

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

  it('closes a stream that resolves after unsubscribe (cancel race)', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const unsubscribe = vi.fn()
    let resolveHandle: (h: unknown) => void = () => {}
    runtimeEnvironmentsSubscribe.mockImplementation(
      () => new Promise((resolve) => (resolveHandle = resolve))
    )
    const onAppended = vi.fn()
    const transport = getNativeChatSessionTransport(ENV)

    const stop = transport.subscribe(
      { subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' },
      onAppended
    )
    stop() // teardown before the subscribe promise resolves
    resolveHandle({ unsubscribe, sendBinary: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(onAppended).not.toHaveBeenCalled()
  })
})

describe('runtime readSession error mapping', () => {
  it('maps a method_not_found rejection to the too-old copy (R4)', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    runtimeEnvironmentsCall.mockResolvedValue({
      ok: false,
      error: { code: 'method_not_found', message: 'no such method' }
    })
    const transport = getNativeChatSessionTransport(ENV)

    const result = await transport.readSession('claude', 'sess-1', 40, undefined)

    expect(result).toEqual({ error: expect.stringContaining('too old') })
  })

  it('maps error classes precisely (KTD-4, not catch-all)', () => {
    const tooOld = expect.stringContaining('too old')
    const generic = "Couldn't read agent chat from the remote runtime."

    expect(
      toRuntimeNativeChatErrorMessage(
        new RuntimeRpcCallError({ id: 'r-1', ok: false, error: { code: 'method_not_found', message: 'x' } })
      )
    ).toEqual(tooOld)

    const compatBlock = Object.assign(new Error('runtime too old'), {
      code: RUNTIME_COMPAT_BLOCK_CODE
    })
    expect(toRuntimeNativeChatErrorMessage(compatBlock)).toEqual(tooOld)

    expect(toRuntimeNativeChatErrorMessage(new Error('request timed out'))).toBe(generic)
  })
})
