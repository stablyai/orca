// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useAppStore } from '@/store'
import { NATIVE_CHAT_INITIAL_LIMIT, nextNativeChatLimit } from './native-chat-pagination'

const { resetTransport, subscriptions, transport } = vi.hoisted(() => {
  type Subscription = {
    onFrame: (frame: unknown) => void
    unsubscribe: ReturnType<typeof vi.fn>
  }
  const subscriptions: Subscription[] = []
  const transport = {
    readSession: vi.fn(),
    subscribe: vi.fn()
  }
  const resetTransport = (): void => {
    subscriptions.splice(0)
    transport.readSession.mockReset().mockImplementation(() => new Promise(() => {}))
    transport.subscribe.mockReset().mockImplementation((_args, onFrame) => {
      const subscription = { onFrame, unsubscribe: vi.fn() }
      subscriptions.push(subscription)
      return subscription.unsubscribe
    })
  }
  return { resetTransport, subscriptions, transport }
})

vi.mock('./native-chat-session-transport', () => ({
  getNativeChatSessionTransport: () => transport
}))

import type {
  NativeChatLiveSession,
  UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'

const BASE_ARGS: UseNativeChatLiveSessionArgs = {
  paneKey: 'tab-1:leaf-1',
  agent: 'claude',
  sessionId: 'session-1',
  transcriptPath: '/remote/session-1.jsonl',
  runtimeEnvironmentId: 'environment-1',
  enabled: true
}

function assistant(id: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp,
    source: 'transcript'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve = (_value: T): void => {}
  let reject = (_reason: unknown): void => {}
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

describe('useNativeChatLiveSession visibility', () => {
  let root: Root
  let latest: NativeChatLiveSession | null = null
  const renders = vi.fn()

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    renders()
    latest = useNativeChatRetainedSession(props)
    return null
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<void> {
    await act(async () => {
      root.render(createElement(Probe, props))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function emit(index: number, frame: unknown): Promise<void> {
    await act(async () => {
      subscriptions[index]?.onFrame(frame)
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    root = createRoot(document.createElement('div'))
    latest = null
    renders.mockClear()
    resetTransport()
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it('does no transcript IO when initially hidden', async () => {
    await render({ ...BASE_ARGS, enabled: false })

    expect(transport.readSession).not.toHaveBeenCalled()
    expect(transport.subscribe).not.toHaveBeenCalled()
  })

  it('unsubscribes on hide, retains committed messages, and rejects hidden work', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [BASE_ARGS.paneKey]: { state: 'working', stateStartedAt: 100 }
      }
    } as never)
    await render(BASE_ARGS)
    await emit(0, {
      type: 'snapshot',
      messages: [assistant('committed', 1)],
      hasMore: true,
      lifecycle: { state: 'working', turnId: 'turn-1', timestamp: 100 }
    })
    const staleLoadEarlier = latest?.loadEarlier

    await render({ ...BASE_ARGS, enabled: false })

    expect(subscriptions[0]?.unsubscribe).toHaveBeenCalledOnce()
    expect(latest?.messages.map((message) => message.id)).toEqual(['committed'])
    expect(latest?.readPhase).toBe('ready')
    expect(latest?.status).toBe('working')

    const readsAfterHide = transport.readSession.mock.calls.length
    staleLoadEarlier?.()
    latest?.loadEarlier()
    expect(transport.readSession).toHaveBeenCalledTimes(readsAfterHide)

    const rendersAfterHide = renders.mock.calls.length
    await act(async () => {
      for (let index = 0; index < 1_000; index += 1) {
        subscriptions[0]?.onFrame({
          type: 'appended',
          messages: [assistant(`stale-hidden-${index}`, index + 2)]
        })
      }
      await Promise.resolve()
    })
    expect(renders).toHaveBeenCalledTimes(rendersAfterHide)
    expect(latest?.messages.map((message) => message.id)).toEqual(['committed'])
  })

  it('cancels a not-found retry when hidden', async () => {
    vi.useFakeTimers()
    transport.readSession.mockResolvedValue({ error: 'not found', notFound: true })

    await render(BASE_ARGS)
    expect(transport.readSession).toHaveBeenCalledOnce()

    await render({ ...BASE_ARGS, enabled: false })
    await act(async () => vi.advanceTimersByTimeAsync(60_000))

    expect(transport.readSession).toHaveBeenCalledOnce()
    expect(subscriptions[0]?.unsubscribe).toHaveBeenCalledOnce()
  })

  it('reopens one fresh stream whose snapshot wins every stale generation', async () => {
    const oldSeed = deferred<{ messages: NativeChatMessage[] }>()
    const freshSeed = deferred<{ messages: NativeChatMessage[] }>()
    transport.readSession
      .mockImplementationOnce(() => oldSeed.promise)
      .mockImplementationOnce(() => freshSeed.promise)

    await render(BASE_ARGS)
    await emit(0, {
      type: 'snapshot',
      messages: [assistant('before-hide', 1)],
      hasMore: false
    })
    await render({ ...BASE_ARGS, enabled: false })
    await render(BASE_ARGS)

    expect(transport.readSession).toHaveBeenCalledTimes(2)
    expect(transport.subscribe).toHaveBeenCalledTimes(2)
    expect(subscriptions[0]?.unsubscribe).toHaveBeenCalledOnce()
    expect(subscriptions[1]?.unsubscribe).not.toHaveBeenCalled()
    expect(latest?.readPhase).toBe('loading')
    expect(latest?.messages.map((message) => message.id)).toEqual(['before-hide'])

    await emit(1, {
      type: 'snapshot',
      messages: [assistant('fresh', 3)],
      hasMore: false
    })
    await emit(0, {
      type: 'replacement',
      messages: [assistant('stale-stream', 4)],
      hasMore: false
    })
    await act(async () => {
      oldSeed.resolve({ messages: [assistant('stale-old-seed', 5)] })
      freshSeed.resolve({ messages: [assistant('stale-fresh-seed', 6)] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.messages.map((message) => message.id)).toEqual(['fresh'])
  })

  it('closes a deferred paired-client stream after a rapid hide and reveal', async () => {
    const deferredTeardown = deferred<() => void>()
    const oldUnsubscribe = vi.fn()
    transport.subscribe.mockImplementationOnce((_args, onFrame) => {
      subscriptions.push({ onFrame, unsubscribe: oldUnsubscribe })
      return deferredTeardown.promise
    })

    await render(BASE_ARGS)
    await render({ ...BASE_ARGS, enabled: false })
    await render(BASE_ARGS)

    expect(transport.subscribe).toHaveBeenCalledTimes(2)
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[1]?.unsubscribe).not.toHaveBeenCalled()

    await act(async () => {
      deferredTeardown.resolve(oldUnsubscribe)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(oldUnsubscribe).toHaveBeenCalledOnce()
    expect(subscriptions[1]?.unsubscribe).not.toHaveBeenCalled()
  })

  it('contains a deferred paired-client stream-handle rejection', async () => {
    const deferredTeardown = deferred<() => void>()
    transport.subscribe.mockImplementationOnce((_args, onFrame) => {
      subscriptions.push({ onFrame, unsubscribe: vi.fn() })
      return deferredTeardown.promise
    })

    await render(BASE_ARGS)
    await act(async () => {
      deferredTeardown.reject(new Error('stream setup failed'))
      await Promise.resolve()
      await Promise.resolve()
    })
    await render({ ...BASE_ARGS, enabled: false })

    expect(transport.subscribe).toHaveBeenCalledOnce()
  })

  it('drops retained messages when the hidden transcript identity changes', async () => {
    await render(BASE_ARGS)
    await emit(0, {
      type: 'snapshot',
      messages: [assistant('session-a', 1)],
      hasMore: false
    })
    await render({ ...BASE_ARGS, enabled: false })
    const hiddenSessionB = {
      ...BASE_ARGS,
      enabled: false,
      sessionId: 'session-2',
      transcriptPath: '/remote/session-2.jsonl',
      runtimeEnvironmentId: 'environment-2'
    }

    await render(hiddenSessionB)
    await render(hiddenSessionB)

    expect(transport.readSession).toHaveBeenCalledOnce()
    expect(transport.subscribe).toHaveBeenCalledOnce()
    expect(latest?.readPhase).toBe('loading')
    expect(latest?.messages).toEqual([])

    await render({ ...hiddenSessionB, enabled: true })
    await emit(1, {
      type: 'snapshot',
      messages: [assistant('session-b', 2)],
      hasMore: false
    })

    expect(transport.readSession).toHaveBeenCalledTimes(2)
    expect(transport.subscribe).toHaveBeenCalledTimes(2)
    expect(latest?.messages.map((message) => message.id)).toEqual(['session-b'])
  })

  it('reveals with the paged window and restarts it only on a source change', async () => {
    const pagedLimit = nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT)
    transport.readSession.mockResolvedValue({ messages: [assistant('read', 0)] })
    const initialMessages = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, index) =>
      assistant(`old-${index}`, index)
    )

    await render(BASE_ARGS)
    await emit(0, { type: 'snapshot', messages: initialMessages, hasMore: true })
    await act(async () => {
      latest?.loadEarlier()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transport.readSession.mock.calls[1]?.[2]).toBe(pagedLimit)

    await render({ ...BASE_ARGS, enabled: false })
    await render(BASE_ARGS)

    expect(transport.readSession.mock.calls[2]?.[2]).toBe(pagedLimit)
    expect(transport.subscribe.mock.calls[1]?.[0]?.limit).toBe(pagedLimit)

    await render({ ...BASE_ARGS, sessionId: 'session-2', transcriptPath: '/remote/session-2.jsonl' })

    expect(transport.readSession.mock.calls[3]?.[2]).toBe(NATIVE_CHAT_INITIAL_LIMIT)
  })

  it('lets the pending read repair a stream error frame', async () => {
    const seed = deferred<{ messages: NativeChatMessage[] }>()
    transport.readSession.mockImplementationOnce(() => seed.promise)

    await render(BASE_ARGS)
    await emit(0, { type: 'snapshot', messages: [], hasMore: false, error: 'stream failed' })
    expect(latest?.status).toBe('error')

    await act(async () => {
      seed.resolve({ messages: [assistant('seeded', 1)] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.readPhase).toBe('ready')
    expect(latest?.messages.map((message) => message.id)).toEqual(['seeded'])
  })

  it('keeps the retained transcript when the reveal stream errors', async () => {
    await render(BASE_ARGS)
    await emit(0, {
      type: 'snapshot',
      messages: [assistant('committed', 1)],
      hasMore: false
    })
    await render({ ...BASE_ARGS, enabled: false })
    await render(BASE_ARGS)
    await emit(1, { type: 'snapshot', messages: [], hasMore: false, error: 'stream failed' })

    expect(latest?.messages.map((message) => message.id)).toEqual(['committed'])
    expect(latest?.status).not.toBe('error')
  })

  it('fences pagination started before a rapid hide and reveal', async () => {
    const initialSeed = deferred<{ messages: NativeChatMessage[] }>()
    const oldPage = deferred<{ messages: NativeChatMessage[] }>()
    const revealSeed = deferred<{ messages: NativeChatMessage[] }>()
    transport.readSession
      .mockImplementationOnce(() => initialSeed.promise)
      .mockImplementationOnce(() => oldPage.promise)
      .mockImplementationOnce(() => revealSeed.promise)
    const initialMessages = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, index) =>
      assistant(`old-${index}`, index)
    )

    await render(BASE_ARGS)
    await emit(0, { type: 'snapshot', messages: initialMessages, hasMore: true })
    await act(async () => latest?.loadEarlier())
    expect(transport.readSession).toHaveBeenCalledTimes(2)

    await render({ ...BASE_ARGS, enabled: false })
    await render(BASE_ARGS)
    await emit(1, {
      type: 'snapshot',
      messages: [assistant('fresh-after-reveal', 1_000)],
      hasMore: false
    })
    await act(async () => {
      oldPage.resolve({ messages: [assistant('stale-page', -1)] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(transport.readSession).toHaveBeenCalledTimes(3)
    expect(latest?.messages.map((message) => message.id)).toEqual(['fresh-after-reveal'])
  })
})
