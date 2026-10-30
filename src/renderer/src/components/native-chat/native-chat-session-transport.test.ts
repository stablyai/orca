import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
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

const web = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), resolve: vi.fn() }))
vi.mock('@/web/preload-api/web-native-chat-api', () => ({ createWebNativeChatApi: web.create }))
vi.mock('@/web/preload-api/web-runtime-session', () => ({
  resolveEnvironment: web.resolve,
  requireActiveEnvironmentOrNull: () => null
}))
const supportsCurrentRequests = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  runtimeEnvironmentSupportsCapability: supportsCurrentRequests
}))

const ENV = 'env-1'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

function okEnvelope(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result }
}

/** Let the compatibility-gate await chain reach the runtime bridge. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve))
}

beforeEach(() => {
  vi.clearAllMocks()
  supportsCurrentRequests.mockResolvedValue(false)
  web.create.mockReturnValue({ readSession: web.read })
  web.resolve.mockImplementation((id) => ({ id }))
  web.read.mockResolvedValue({ messages: [] })
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
      params: {
        agent: 'claude',
        sessionId: 'sess-1',
        limit: 40,
        transcriptPath: '/t/path',
        capabilities: { transcriptSourceOrder: 1 }
      },
      timeoutMs: 15_000
    })
    expect(nativeChatReadSession).not.toHaveBeenCalled()
  })

  it('validates lifecycle metadata on runtime read responses', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const lifecycle = { state: 'completed', turnId: 'turn-1', timestamp: 42 } as const
    runtimeEnvironmentsCall
      .mockResolvedValueOnce(okEnvelope({ messages: [message('valid')], lifecycle }))
      .mockResolvedValueOnce(
        okEnvelope({
          messages: [message('invalid')],
          lifecycle: { state: 'completed', turnId: '', timestamp: undefined }
        })
      )
    const transport = getNativeChatSessionTransport(ENV)

    await expect(transport.readSession('claude', 'sess-1')).resolves.toEqual({
      messages: [message('valid')],
      lifecycle
    })
    await expect(transport.readSession('claude', 'sess-1')).resolves.toEqual({
      messages: [message('invalid')]
    })
  })

  it('accepts interrupted lifecycle metadata from a remote runtime', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const lifecycle = { state: 'interrupted', turnId: 'turn-2', timestamp: 43 } as const
    runtimeEnvironmentsCall.mockResolvedValueOnce(
      okEnvelope({ messages: [message('interrupted')], lifecycle })
    )
    const transport = getNativeChatSessionTransport(ENV)

    await expect(transport.readSession('codex', 'sess-1')).resolves.toEqual({
      messages: [message('interrupted')],
      lifecycle
    })
  })

  it('keeps lifecycle metadata whose timestamp is omitted, normalizing it to null', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    runtimeEnvironmentsCall.mockResolvedValueOnce(
      okEnvelope({
        messages: [message('no-ts')],
        lifecycle: { state: 'completed', turnId: 'turn-3' }
      })
    )
    const transport = getNativeChatSessionTransport(ENV)

    await expect(transport.readSession('claude', 'sess-1')).resolves.toEqual({
      messages: [message('no-ts')],
      lifecycle: { state: 'completed', turnId: 'turn-3', timestamp: null }
    })
  })

  it('captures the browser owner in its web adapter instead of the desktop bridge', async () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    nativeChatReadSession.mockResolvedValue({ messages: [] })
    const transport = getNativeChatSessionTransport(ENV)

    await transport.readSession('claude', 'sess-1', 40, undefined)

    expect(web.create).toHaveBeenCalledWith({ environment: { id: ENV } })
    expect(web.read).toHaveBeenCalledWith('claude', 'sess-1', 40, undefined)
    expect(nativeChatReadSession).not.toHaveBeenCalled()
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

  it('normalizes the first frame to a snapshot and reconnect replays to appends', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onFrame = vi.fn()
    const transport = getNativeChatSessionTransport(ENV)

    transport.subscribe({ subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' }, onFrame)
    await flushMicrotasks()

    expect(runtimeEnvironmentsSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          capabilities: { transcriptPending: 1, transcriptSourceOrder: 1 }
        })
      }),
      expect.any(Object)
    )

    deliver({ type: 'appended', messages: [message('m-1')] })
    deliver({ type: 'snapshot', messages: [message('m-snapshot')] })
    deliver({ type: 'replacement', messages: [message('m-replacement')], hasMore: true })
    deliver({ type: 'ready' })
    deliver({ type: 'appended', messages: undefined })
    deliver({ type: 'appended', messages: [message('m-2')] }, false)

    expect(onFrame).toHaveBeenCalledTimes(3)
    expect(onFrame).toHaveBeenNthCalledWith(1, {
      type: 'snapshot',
      messages: [message('m-1')],
      hasMore: false
    })
    expect(onFrame).toHaveBeenNthCalledWith(2, {
      type: 'snapshot',
      messages: [message('m-snapshot')],
      hasMore: false
    })
    expect(onFrame).toHaveBeenNthCalledWith(3, {
      type: 'replacement',
      messages: [message('m-replacement')],
      hasMore: true
    })
  })

  it('validates lifecycle metadata on runtime stream frames', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onFrame = vi.fn()
    const transport = getNativeChatSessionTransport(ENV)
    const lifecycle = { state: 'completed', turnId: 'turn-1', timestamp: 42 } as const

    transport.subscribe({ subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' }, onFrame)
    await flushMicrotasks()
    deliver({
      type: 'snapshot',
      messages: [message('valid')],
      lifecycle
    })
    deliver({
      type: 'appended',
      messages: [message('invalid')],
      lifecycle: { state: 'completed', turnId: '', timestamp: undefined }
    })

    expect(onFrame).toHaveBeenNthCalledWith(1, {
      type: 'snapshot',
      messages: [message('valid')],
      hasMore: false,
      lifecycle
    })
    expect(onFrame).toHaveBeenNthCalledWith(2, {
      type: 'appended',
      messages: [message('invalid')]
    })
  })

  it('omits an invalid lifecycle payload from a stream frame', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onFrame = vi.fn()
    const transport = getNativeChatSessionTransport(ENV)

    transport.subscribe({ subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' }, onFrame)
    await flushMicrotasks()
    deliver({
      type: 'snapshot',
      messages: [message('seed')],
      hasMore: false,
      lifecycle: { state: 'completed', turnId: 'turn-ok', timestamp: 1 }
    })
    deliver({
      type: 'appended',
      messages: [message('bad-lifecycle')],
      lifecycle: { state: 'completed', turnId: '', timestamp: undefined }
    })

    expect(onFrame).toHaveBeenNthCalledWith(2, {
      type: 'appended',
      messages: [message('bad-lifecycle')]
    })
  })

  it('settles with an empty snapshot when the first ok frame is an unrecognized shape', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onFrame = vi.fn()
    const transport = getNativeChatSessionTransport(ENV)

    transport.subscribe({ subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' }, onFrame)
    await flushMicrotasks()

    // Settle unrecognized successful payloads once, carrying any host error.
    deliver({ type: 'ready', error: 'boom' })
    deliver({ type: 'ready' })

    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onFrame).toHaveBeenCalledWith({
      type: 'snapshot',
      messages: [],
      hasMore: false,
      error: 'boom'
    })
  })

  it('forwards the pending flag and still treats the real snapshot as the initial frame', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onFrame = vi.fn()
    const transport = getNativeChatSessionTransport(ENV)

    transport.subscribe(
      { subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1', limit: 1 },
      onFrame
    )
    await flushMicrotasks()

    deliver({ type: 'snapshot', messages: [], hasMore: false, pending: true })
    deliver({ type: 'snapshot', messages: [message('m-1')] })

    expect(onFrame).toHaveBeenNthCalledWith(1, {
      type: 'snapshot',
      messages: [],
      hasMore: false,
      pending: true
    })
    // Pending frames must not consume the initial slot or keep later real snapshots unsettled.
    expect(onFrame).toHaveBeenNthCalledWith(2, {
      type: 'snapshot',
      messages: [message('m-1')],
      hasMore: true
    })
  })

  it('carries an error on a post-initial reconnect snapshot', async () => {
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onFrame = vi.fn()
    const transport = getNativeChatSessionTransport(ENV)

    transport.subscribe({ subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' }, onFrame)
    await flushMicrotasks()

    deliver({ type: 'snapshot', messages: [message('m-1')] })
    deliver({ type: 'snapshot', messages: [], error: 'runtime too old' })

    expect(onFrame).toHaveBeenLastCalledWith({
      type: 'snapshot',
      messages: [],
      hasMore: false,
      error: 'runtime too old'
    })
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
    // Socket closure reaps its watcher; an unsubscribe RPC uses a different connection and cleanup key.
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
      await flushMicrotasks()
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

  it('closes an out-of-order stale handle without replacing the active reconnect', async () => {
    vi.useFakeTimers()
    try {
      markRuntimeEnvironmentCompatible(ENV)
      const attempts: {
        callbacks: { onClose?: () => void }
        resolve: (handle: { unsubscribe: () => void; sendBinary: () => void }) => void
      }[] = []
      runtimeEnvironmentsSubscribe.mockImplementation((_args, callbacks) => {
        return new Promise((resolve) => attempts.push({ callbacks, resolve }))
      })
      const transport = getNativeChatSessionTransport(ENV)
      const stop = transport.subscribe(
        { subscriptionId: 's-1', agent: 'claude', sessionId: 'sess-1' },
        vi.fn()
      )

      await flushMicrotasks()
      attempts[0]!.callbacks.onClose?.()
      await vi.advanceTimersByTimeAsync(RUNTIME_NATIVE_CHAT_RECONNECT_MS)
      const activeUnsubscribe = vi.fn()
      attempts[1]!.resolve({ unsubscribe: activeUnsubscribe, sendBinary: vi.fn() })
      await flushMicrotasks()
      const staleUnsubscribe = vi.fn()
      attempts[0]!.resolve({ unsubscribe: staleUnsubscribe, sendBinary: vi.fn() })
      await flushMicrotasks()
      stop()

      expect(staleUnsubscribe).toHaveBeenCalledOnce()
      expect(activeUnsubscribe).toHaveBeenCalledOnce()
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
    await flushMicrotasks()
    stop() // teardown before the subscribe promise resolves
    resolveHandle({ unsubscribe, sendBinary: vi.fn() })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(onAppended).not.toHaveBeenCalled()
  })

  it('opens the normal legacy stream when optional current-request discovery rejects', async () => {
    supportsCurrentRequests.mockRejectedValueOnce(new Error('Optional probe failed'))
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onFrame = vi.fn()
    const stop = getNativeChatSessionTransport(ENV).subscribe(
      { subscriptionId: 'fallback', agent: 'codex', sessionId: 'sess-1' },
      onFrame
    )
    await flushMicrotasks()
    expect(runtimeEnvironmentsSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          capabilities: { transcriptPending: 1, transcriptSourceOrder: 1 }
        })
      }),
      expect.any(Object)
    )
    deliver({ type: 'snapshot', messages: [message('legacy-output')] })
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'snapshot',
        messages: [message('legacy-output')]
      })
    )
    stop()
  })

  it('opts into current controls only on a capable runtime and preserves its marker', async () => {
    supportsCurrentRequests.mockResolvedValue(true)
    markRuntimeEnvironmentCompatible(ENV)
    const { deliver } = stubSubscribe()
    const onFrame = vi.fn()
    const stop = getNativeChatSessionTransport(ENV).subscribe(
      { subscriptionId: 's-1', agent: 'codex', sessionId: 'sess-1' },
      onFrame
    )
    await flushMicrotasks()
    expect(runtimeEnvironmentsSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          capabilities: { transcriptPending: 1, transcriptSourceOrder: 1, currentRequests: 2 }
        })
      }),
      expect.any(Object)
    )
    const currentRequests = {
      contract: 'agent-session.current-requests.v2',
      sessionId: 'sess-1',
      epoch: 'e',
      publisher: 'p',
      revision: 1,
      owner: 'o',
      version: 'v'
    }
    deliver({ type: 'snapshot', messages: [], currentRequests })
    expect(onFrame).toHaveBeenCalledWith({
      type: 'snapshot',
      messages: [],
      hasMore: false,
      currentRequests
    })
    stop()
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
        new RuntimeRpcCallError({
          id: 'r-1',
          ok: false,
          error: { code: 'method_not_found', message: 'x' }
        })
      )
    ).toEqual(tooOld)

    const compatBlock = Object.assign(new Error('runtime too old'), {
      code: RUNTIME_COMPAT_BLOCK_CODE
    })
    expect(toRuntimeNativeChatErrorMessage(compatBlock)).toEqual(tooOld)

    expect(toRuntimeNativeChatErrorMessage(new Error('request timed out'))).toBe(generic)
  })
})
