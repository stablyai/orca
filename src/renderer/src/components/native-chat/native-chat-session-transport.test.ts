import type { AgentSessionCurrentRequestsState } from '../../../../shared/agent-session-current-requests'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import {
  messageCancelAction,
  getNativeChatSessionTransport,
  RUNTIME_NATIVE_CHAT_RECONNECT_MS
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
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve()
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve))
}

beforeEach(() => {
  vi.clearAllMocks()
  replaceRuntimeEnvironmentRevisions([])
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 1 }])
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
        subscribe: runtimeEnvironmentsSubscribe,
        cancelSubscription: vi.fn(async () => {})
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

it('routes exact-ID Cancel through the captured native or remote resource adapter', async () => {
  const request = {
    agent: 'codex' as const,
    sessionId: 'same-session',
    transcriptPath: '/canonical/source',
    ids: ['displayed-Q1']
  }
  const localCancel = vi.fn(async () => {})
  Object.assign(window.api.nativeChat, { cancelCurrentQuestions: localCancel })
  await messageCancelAction(
    getNativeChatSessionTransport(null),
    request.agent,
    request.sessionId,
    request.transcriptPath
  )(request.ids)
  expect(localCancel).toHaveBeenCalledExactlyOnceWith(request)
  markRuntimeEnvironmentCompatible(ENV)
  runtimeEnvironmentsSubscribe.mockImplementation(async (_params, handlers) => {
    handlers.onResponse(okEnvelope({ cancelled: true }))
    return { unsubscribe: vi.fn() }
  })
  const remote = getNativeChatSessionTransport(ENV)
  await messageCancelAction(
    remote,
    request.agent,
    request.sessionId,
    request.transcriptPath
  )(request.ids)
  expect(runtimeEnvironmentsSubscribe).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: ENV,
      method: 'nativeChat.cancelCurrentQuestions',
      params: request,
      expectedEnvironmentPairingRevision: 1,
      timeoutMs: 15_000
    }),
    expect.objectContaining({ onResponse: expect.any(Function) })
  )
  expect(nativeChatSubscribe).not.toHaveBeenCalled()
  expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
})

it.each([10, 100])(
  'removes actual queued desktop reads across %i superseded/disposed views and a same-ID host replacement',
  async (count) => {
    const { RuntimeRpcCallQueuePool } = await import('../../../../shared/runtime-rpc-call-queue')
    const { createNativeChatCurrentRequestsBinding } =
      await import('../../../../shared/native-chat-current-requests-binding')
    const queue = new RuntimeRpcCallQueuePool(1)
    const owned = new Map<string, AbortController>()
    const dispatched: string[] = []
    let release = () => {}
    const blocker = queue.enqueue(
      ENV,
      'terminal.send',
      async () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const cancelSubscription = vi.fn(async ({ subscriptionId }: { subscriptionId: string }) => {
      owned.get(subscriptionId)?.abort()
    })
    Object.assign(window.api.runtimeEnvironments, { cancelSubscription })
    const marker = {
      contract: 'agent-session.current-requests.v2',
      sessionId: 'same-session',
      epoch: 'physical-A',
      publisher: 'source-A',
      owner: 'source-A:owner',
      revision: 1,
      version: 'A1'
    }
    runtimeEnvironmentsSubscribe.mockImplementation(async (params, handlers) => {
      const controller = new AbortController()
      owned.set(params.subscriptionId, controller)
      void queue
        .enqueue(
          params.selector,
          params.method,
          async () => {
            dispatched.push(params.method)
            expect(params.expectedEnvironmentPairingRevision).toBe(2)
            handlers.onResponse(
              okEnvelope({
                marker: { ...marker, version: 'B1', publisher: 'source-B' },
                json: JSON.stringify({
                  blocking: [],
                  asyncQuestions: [],
                  context: { sessionId: 'same-session', boundary: 'root' }
                }),
                nextCursor: null
              })
            )
          },
          0,
          controller.signal
        )
        .catch((error) => handlers.onError({ message: String(error) }))
        .finally(() => owned.delete(params.subscriptionId))
      return { unsubscribe: () => controller.abort() }
    })
    markRuntimeEnvironmentCompatible(ENV)
    const old = getNativeChatSessionTransport(ENV)
    const request = {
      agent: 'codex' as const,
      sessionId: 'same-session',
      transcriptPath: '/source'
    }
    for (let i = 0; i < count; i++) {
      const binding = createNativeChatCurrentRequestsBinding({
        read: (read, signal) => old.currentRequests!({ ...read, ...request }, signal),
        publish: () => {}
      })
      binding.observe({
        type: 'appended',
        currentRequests: { ...marker, revision: i + 1, version: `A${i + 1}` }
      })
      await flushMicrotasks()
      binding.invalidate()
    }
    await flush()
    expect(Reflect.get(queue, 'queuedCallCount')).toBe(0)
    expect(dispatched).toEqual([])
    expect(owned.size).toBe(0)
    const cancel = messageCancelAction(
      old,
      request.agent,
      request.sessionId,
      request.transcriptPath
    )(['displayed-only']).catch((error) => error)
    await flush()
    expect(Reflect.get(queue, 'queuedCallCount')).toBe(1)
    replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 2 }], {
      retired: [ENV],
      sameHost: []
    })
    await expect(cancel).resolves.toMatchObject({ name: 'AbortError' })
    expect(Reflect.get(queue, 'queuedCallCount')).toBe(0)
    await expect(
      old.currentRequests!({ ...request, version: 'A1' }, new AbortController().signal)
    ).rejects.toThrow('server changed')
    release()
    await blocker
    await flush()
    expect(dispatched).toEqual([])
    markRuntimeEnvironmentCompatible(ENV)
    const current = getNativeChatSessionTransport(ENV)
    let installed = false
    const binding = createNativeChatCurrentRequestsBinding({
      read: (read, signal) => current.currentRequests!({ ...read, ...request }, signal),
      publish: (state) => {
        installed = state.asyncQuestionAuthority?.version === 'B1'
      }
    })
    binding.observe({
      type: 'appended',
      currentRequests: { ...marker, publisher: 'source-B', version: 'B1' }
    })
    await vi.waitFor(() => expect(installed).toBe(true))
    binding.invalidate()
    await flush()
    expect(dispatched).toEqual(['nativeChat.currentRequests'])
    expect(Reflect.get(queue, 'queuedCallCount')).toBe(0)
    expect(owned.size).toBe(0)
  }
)

it('keeps a captured native resource across proven and pending same-host continuation', async () => {
  markRuntimeEnvironmentCompatible(ENV)
  const transport = getNativeChatSessionTransport(ENV)
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 2 }], {
    retired: [],
    sameHost: [{ id: ENV, fromRevision: 1, toRevision: 2 }]
  })
  runtimeEnvironmentsCall.mockResolvedValue(okEnvelope({ messages: [message('continued')] }))
  await expect(transport.readSession('codex', 'chat')).resolves.toMatchObject({
    messages: [message('continued')]
  })
  expect(runtimeEnvironmentsCall).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedEnvironmentPairingRevision: 2 })
  )
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 3 }], {
    retired: [],
    sameHost: [],
    pending: [{ id: ENV, fromRevision: 2 }]
  })
  // The existing main qualification queue owns pending host proof, not a new physical-read refusal.
  runtimeEnvironmentsCall.mockImplementation(async () => {
    replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 3 }], {
      retired: [],
      sameHost: [{ id: ENV, fromRevision: 2, toRevision: 3 }]
    })
    return okEnvelope({ messages: [message('proved')] })
  })
  await expect(transport.readSession('codex', 'chat')).resolves.toMatchObject({
    messages: [message('proved')]
  })
  expect(runtimeEnvironmentsCall).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedEnvironmentPairingRevision: 2 })
  )
})

it.each(['pending', 'cancelled'] as const)(
  'retains established %s authority through actual failed-probe reconnect without history revival',
  async (outcome) => {
    const { createNativeChatCurrentRequestsBinding } =
      await import('../../../../shared/native-chat-current-requests-binding')
    const { currentAsyncQuestion, currentMessageQuestionView } =
      await import('../../../../shared/agent-session-current-requests')
    const { messageQuestionFixture } =
      await import('../../../../shared/message-question-occurrence.test-fixture')
    const marker = {
      contract: 'agent-session.current-requests.v2',
      sessionId: 'chat',
      epoch: 'epoch',
      publisher: 'publisher',
      owner: 'owner',
      revision: 1,
      version: 'version'
    }
    const legacy: NativeChatMessage = {
      ...message('historical-question'),
      blocks: [
        {
          type: 'tool-call',
          id: 'legacy-call',
          name: 'request_user_input_async',
          input: {
            questions: [
              { question: 'Historical question', options: [{ label: 'A' }, { label: 'B' }] }
            ]
          }
        }
      ]
    }
    let state: AgentSessionCurrentRequestsState = {}
    let failRead = false
    let stream:
      | { onResponse: (response: { ok: true; result: unknown }) => void; onClose: () => void }
      | undefined
    let binding: ReturnType<typeof createNativeChatCurrentRequestsBinding> | undefined
    let stop: (() => void) | undefined
    const read = vi.fn(async () => {
      if (failRead) {
        throw new Error('Read temporarily unavailable')
      }
      return {
        marker,
        nextCursor: null,
        json: JSON.stringify({
          blocking: [],
          asyncQuestions: outcome === 'pending' ? [messageQuestionFixture('outside-history')] : [],
          context: { sessionId: 'chat', boundary: 'root' }
        })
      }
    })
    try {
      markRuntimeEnvironmentCompatible(ENV)
      supportsCurrentRequests
        .mockResolvedValueOnce(true)
        .mockRejectedValue(new Error('Transient discovery failure'))
      runtimeEnvironmentsSubscribe.mockImplementation(async (args, handlers) => {
        if (args.method === 'nativeChat.currentRequests') {
          try {
            handlers.onResponse(okEnvelope(await read()))
          } catch (error) {
            handlers.onError({ message: String(error) })
          }
        } else {
          stream = handlers
        }
        return { unsubscribe: vi.fn() }
      })
      const transport = getNativeChatSessionTransport(ENV)
      binding = createNativeChatCurrentRequestsBinding({
        read: (request, signal) =>
          transport.currentRequests({ ...request, agent: 'codex', sessionId: 'chat' }, signal),
        publish: (next) => {
          state = next
        }
      })
      stop = transport.subscribe(
        { subscriptionId: 'reconnect', agent: 'codex', sessionId: 'chat' },
        (frame) => binding!.observe(frame)
      )
      await flush()
      stream!.onResponse(okEnvelope({ type: 'snapshot', messages: [], currentRequests: marker }))
      await vi.waitFor(() => expect(currentMessageQuestionView(state)?.ready).toBe(true))
      const retained = state.asyncQuestions
      expect(currentAsyncQuestion(state, [legacy])?.questions[0]?.question).toBe(
        outcome === 'pending' ? 'Which color?' : undefined
      )
      failRead = true
      vi.useFakeTimers()
      stream!.onClose()
      await vi.advanceTimersByTimeAsync(RUNTIME_NATIVE_CHAT_RECONNECT_MS)
      expect(runtimeEnvironmentsSubscribe).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            capabilities: { transcriptPending: 1, transcriptSourceOrder: 1, currentRequests: 2 }
          })
        }),
        expect.any(Object)
      )
      stream!.onResponse(okEnvelope({ type: 'snapshot', messages: [legacy] }))
      await vi.advanceTimersByTimeAsync(0)
      expect(currentMessageQuestionView(state)?.ready).toBe(false)
      expect(state.asyncQuestions).toBe(retained)
      expect(currentAsyncQuestion(state, [legacy])?.questions[0]?.question).toBe(
        outcome === 'pending' ? 'Which color?' : undefined
      )
      failRead = false
      await vi.advanceTimersByTimeAsync(750)
      expect(currentMessageQuestionView(state)?.ready).toBe(true)
      expect(state.asyncQuestions).toEqual(retained)
    } finally {
      binding?.invalidate()
      stop?.()
      vi.useRealTimers()
    }
  }
)
