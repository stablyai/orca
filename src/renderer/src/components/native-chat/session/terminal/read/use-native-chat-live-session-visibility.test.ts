// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { useAppStore } from '@/store'
import { NATIVE_CHAT_INITIAL_LIMIT } from '../../../viewport/history/native-chat-pagination'

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
} from './native-chat-live-session-contract'

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
    await act(async () => {
      void latest?.loadEarlier()
    })
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
  it.each(['seed', 'snapshot'] as const)(
    'bounds both retained buffers on return to live from a %s base and retires late history',
    async (source) => {
      const initial = Array.from({ length: 300 }, (_, index) =>
        assistant(`message-${index + 700}`, index + 700)
      )
      const expanded = Array.from({ length: 500 }, (_, index) =>
        assistant(`message-${index + 500}`, index + 500)
      )
      const late = deferred<{ messages: NativeChatMessage[] }>()
      transport.readSession
        .mockResolvedValueOnce({ messages: initial })
        .mockResolvedValueOnce({ messages: expanded })
        .mockImplementationOnce(() => late.promise)
      await render(BASE_ARGS)
      if (source === 'snapshot') {
        await emit(0, { type: 'snapshot', messages: initial, hasMore: true })
      }
      await act(async () => {
        await latest?.loadEarlier()
      })
      await emit(0, {
        type: 'append',
        messages: Array.from({ length: 400 }, (_, index) =>
          assistant(`live-${index}`, index + 1000)
        )
      })
      expect((latest?.messages.length ?? 0) > 600).toBe(true)
      let oldRead: Promise<string> | undefined
      await act(async () => {
        oldRead = latest?.loadEarlier()
      })
      await act(async () => {
        latest?.trimHistory?.()
      })
      expect(latest?.messages.map((row) => row.id)).toEqual(
        Array.from({ length: 300 }, (_, index) => `live-${index + 100}`)
      )
      expect(latest?.messages.at(-1)?.id).toBe('live-399')
      expect(latest?.hasMore).toBe(true)
      expect(latest?.loadingEarlier).toBe(false)
      await act(async () => {
        late.resolve({ messages: [assistant('stale-page', -1)] })
        await expect(oldRead).resolves.toBe('superseded')
      })
      expect(latest?.messages.at(-1)?.id).toBe('live-399')
      transport.readSession.mockResolvedValueOnce({ messages: expanded })
      await act(async () => {
        await latest?.loadEarlier()
      })
      expect(transport.readSession.mock.calls.at(-1)?.[2]).toBe(500)
      expect(subscriptions[0]?.unsubscribe).not.toHaveBeenCalled()
    }
  )
  it('retires the first older read when returning before it enlarged the budget', async () => {
    const initial = Array.from({ length: 300 }, (_, index) =>
      assistant(`row-${index + 700}`, index + 700)
    )
    const older = deferred<{ messages: NativeChatMessage[] }>()
    transport.readSession
      .mockResolvedValueOnce({ messages: initial })
      .mockImplementationOnce(() => older.promise)
    await render(BASE_ARGS)
    let request: Promise<string> | undefined
    await act(async () => {
      request = latest?.loadEarlier()
    })
    await act(async () => latest?.trimHistory?.())
    await act(async () => {
      older.resolve({
        messages: Array.from({ length: 500 }, (_, index) =>
          assistant(`row-${index + 500}`, index + 500)
        )
      })
      await expect(request).resolves.toBe('superseded')
    })
    expect(latest?.messages.map((row) => row.id)).toEqual(initial.map((row) => row.id))
    expect(latest?.loadingEarlier).toBe(false)
  })

  it.each(['seed', 'snapshot'] as const)(
    'applies the current budget to a late enlarged reveal %s',
    async (source) => {
      const initial = Array.from({ length: 300 }, (_, index) =>
        assistant(`row-${index + 700}`, index + 700)
      )
      const expanded = Array.from({ length: 500 }, (_, index) =>
        assistant(`row-${index + 500}`, index + 500)
      )
      const reveal = deferred<{ messages: NativeChatMessage[] }>()
      transport.readSession
        .mockResolvedValueOnce({ messages: initial })
        .mockResolvedValueOnce({ messages: expanded })
        .mockImplementationOnce(() => reveal.promise)
      await render(BASE_ARGS)
      await act(async () => {
        await latest?.loadEarlier()
      })
      await render({ ...BASE_ARGS, enabled: false })
      await render(BASE_ARGS)
      await act(async () => latest?.trimHistory?.())
      if (source === 'snapshot') {
        await emit(1, { type: 'snapshot', messages: expanded, hasMore: false })
      }
      await act(async () => reveal.resolve({ messages: expanded }))
      expect(latest?.messages.map((row) => row.id)).toEqual(initial.map((row) => row.id))
      expect(latest?.hasMore).toBe(true)
      expect(subscriptions[1]?.unsubscribe).not.toHaveBeenCalled()
    }
  )
})
