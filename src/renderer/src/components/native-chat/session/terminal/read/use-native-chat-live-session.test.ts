// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { useAppStore } from '@/store/index'
import { NATIVE_CHAT_INITIAL_LIMIT } from '@/components/native-chat/viewport/history/native-chat-pagination'

// Separate transports per owner make host changes observable.
const { transportFactory, getMockTransport, resetMockTransports } = vi.hoisted(() => {
  type MockTransport = {
    readSession: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
    emit: (frame: unknown) => void
  }
  const transports = new Map<string | null, MockTransport>()
  // Disable autoSnapshot for an unflushed transcript with a silent resolve poll; only readSession can settle it (#8401).
  const getMockTransport = (
    ownerId: string | null,
    opts?: { autoSnapshot?: boolean }
  ): MockTransport => {
    let transport = transports.get(ownerId)
    if (!transport) {
      const unsubscribe = vi.fn()
      let listener: (frame: unknown) => void = () => {}
      transport = {
        unsubscribe,
        readSession: vi.fn().mockResolvedValue({ messages: [] }),
        subscribe: vi.fn((_args, onFrame) => {
          listener = onFrame
          if (opts?.autoSnapshot !== false) {
            onFrame({ type: 'snapshot', messages: [], hasMore: false })
          }
          return unsubscribe
        }),
        emit: (frame) => listener(frame)
      }
      transports.set(ownerId, transport)
    }
    return transport
  }
  return {
    getMockTransport,
    resetMockTransports: () => transports.clear(),
    transportFactory: vi.fn((ownerId: string | null) => getMockTransport(ownerId))
  }
})

vi.mock('./native-chat-session-transport', () => ({
  getNativeChatSessionTransport: transportFactory
}))

import { useNativeChatLiveSession } from '@/components/native-chat/session/terminal/read/use-native-chat-live-session'
import type {
  UseNativeChatLiveSessionArgs,
  NativeChatLiveSession
} from '@/components/native-chat/session/terminal/read/native-chat-live-session-contract'

function assistant(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 2,
    source: 'transcript'
  }
}

function user(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

describe('useNativeChatLiveSession — transport routing', () => {
  const AGENT = 'claude' as const
  const SESSION = 'sess-1'
  const PANE = 'pane-1'
  const roots: Root[] = []
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatLiveSession(props)
    return null
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<Root> {
    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(createElement(Probe, props))
    })
    await flush()
    return root
  }

  async function rerender(root: Root, props: UseNativeChatLiveSessionArgs): Promise<void> {
    await act(async () => {
      root.render(createElement(Probe, props))
    })
    await flush()
  }

  beforeEach(() => {
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount())
    }
    latest = null
    vi.clearAllMocks()
    resetMockTransports()
  })

  it('discards a load-earlier resolve from the previous owner after a flip', async () => {
    const many = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, n) =>
      assistant(`m-${n}`, 't')
    )
    const first = getMockTransport('env-1')

    const root = await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-1'
    })
    await act(async () => {
      first.emit({ type: 'snapshot', messages: many, hasMore: true })
    })
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    first.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    await act(async () => {
      void latest?.loadEarlier()
    })
    await rerender(root, {
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-2'
    })
    // Late env-1 history must not paint into the new env-2 pane.
    await act(async () => {
      resolveEarlier({ messages: [assistant('stale', 'from-env-1')] })
      await Promise.resolve()
    })

    expect(latest?.messages.map((m) => m.id)).not.toContain('stale')
  })

  it('discards a load-earlier resolve from before transcript replacement', async () => {
    const transport = getMockTransport('env-1')
    const many = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, n) =>
      assistant(`old-${n}`, 'old')
    )
    await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-1'
    })
    await act(async () => transport.emit({ type: 'snapshot', messages: many, hasMore: true }))
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    await act(async () => {
      void latest?.loadEarlier()
    })

    await act(async () =>
      transport.emit({
        type: 'replacement',
        messages: [assistant('replacement', 'new inode')],
        hasMore: false
      })
    )
    await act(async () => {
      resolveEarlier({ messages: [assistant('stale-page', 'old inode')] })
      await Promise.resolve()
    })

    expect(latest?.messages.map((message) => message.id)).toEqual(['replacement'])
  })

  it('shares one in-flight older page, and its result, with every caller', async () => {
    const transport = getMockTransport('env-1')
    const many = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, n) =>
      assistant(`old-${n}`, 'old')
    )
    await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-1'
    })
    await act(async () => transport.emit({ type: 'snapshot', messages: many, hasMore: true }))
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    const readsBefore = transport.readSession.mock.calls.length

    let first: Promise<string> | undefined
    let second: Promise<string> | undefined
    await act(async () => {
      first = latest?.loadEarlier()
    })
    await act(async () => {
      second = latest?.loadEarlier()
    })
    expect(second).toBe(first)
    await act(async () => {
      resolveEarlier({ messages: [assistant('older', 'older'), ...many] })
      await first
    })

    await expect(second).resolves.toBe('applied')
    expect(latest?.readPhase).toBe('ready')
    expect(latest?.sourceObservation?.context?.sessionId).toBe('sess-1')
    expect(transport.readSession.mock.calls.length).toBe(readsBefore + 1)
    expect(latest?.loadingEarlier).toBe(false)
  })

  it('discards a load-earlier resolve from before a reconnect snapshot', async () => {
    const transport = getMockTransport('env-1')
    const many = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, n) =>
      assistant(`old-${n}`, 'old')
    )
    await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-1'
    })
    await act(async () => transport.emit({ type: 'snapshot', messages: many, hasMore: true }))
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    await act(async () => {
      void latest?.loadEarlier()
    })

    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [assistant('reconnected', 'fresh snapshot')],
        hasMore: false
      })
    )
    await act(async () => {
      resolveEarlier({ messages: [assistant('stale-page', 'old generation')] })
      await Promise.resolve()
    })

    expect(latest?.messages.map((message) => message.id)).toEqual(['reconnected'])
  })

  it('discards a load-earlier resolve from before a transcript-path rebind', async () => {
    const transport = getMockTransport('env-1')
    const many = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, n) =>
      assistant(`old-path-${n}`, 'old')
    )
    const root = await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      transcriptPath: '/old/transcript',
      runtimeEnvironmentId: 'env-1'
    })
    await act(async () => transport.emit({ type: 'snapshot', messages: many, hasMore: true }))
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    await act(async () => {
      void latest?.loadEarlier()
    })

    await rerender(root, {
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      transcriptPath: '/new/transcript',
      runtimeEnvironmentId: 'env-1'
    })
    await act(async () => {
      resolveEarlier({ messages: [assistant('stale-old-path', 'old transcript')] })
      await Promise.resolve()
    })

    expect(latest?.messages.map((message) => message.id)).not.toContain('stale-old-path')
  })

  it('seeds ready from readSession when the subscription never delivers a frame', async () => {
    const transport = getMockTransport('env-1')
    // Older hosts may stream only appends; the seed must settle an empty tail.
    transport.subscribe.mockImplementation(() => transport.unsubscribe)
    transport.readSession.mockResolvedValueOnce({ messages: [user('u-seed', 'hi')] })

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })

    expect(latest?.status).not.toBe('loading')
    expect(latest?.messages.map((message) => message.id)).toEqual(['u-seed'])
  })

  it('does not let an older pagination read rewind a live completion', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE]: { state: 'working', stateStartedAt: 1, updatedAt: Date.now() } as never
      }
    })
    const transport = getMockTransport('env-1')
    const many = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, index) =>
      assistant(`m-${index}`, 'working')
    )
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: many,
        hasMore: true,
        lifecycle: { state: 'working', turnId: 'turn-1', timestamp: 1 }
      })
    )

    let resolveEarlier: (result: {
      messages: NativeChatMessage[]
      lifecycle: { state: 'working'; turnId: string; timestamp: number }
    }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    await act(async () => {
      void latest?.loadEarlier()
    })
    await act(async () =>
      transport.emit({
        type: 'appended',
        messages: [],
        lifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 2 }
      })
    )
    expect(latest?.status).toBe('ready')

    await act(async () => {
      resolveEarlier({
        messages: many,
        lifecycle: { state: 'working', turnId: 'turn-1', timestamp: 1 }
      })
      await Promise.resolve()
    })

    expect(latest?.status).toBe('ready')
  })
})

// New sessions can take minutes to flush; a first-read miss must remain recoverable (#8401).
describe('useNativeChatLiveSession — notFound retry (#8401)', () => {
  const AGENT = 'claude' as const
  const SESSION = 'sess-notfound'
  const PANE = 'pane-notfound'
  const roots: Root[] = []
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatLiveSession(props)
    return null
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<Root> {
    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(createElement(Probe, props))
      await Promise.resolve()
      await Promise.resolve()
    })
    return root
  }

  beforeEach(() => {
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount())
    }
    latest = null
    vi.clearAllMocks()
    resetMockTransports()
    vi.useRealTimers()
  })

  it('retries a notFound miss with backoff and settles into ready without ever exposing an error', async () => {
    vi.useFakeTimers()
    const transport = getMockTransport('env-1', { autoSnapshot: false })
    transport.readSession
      .mockResolvedValueOnce({ error: 'No transcript found', notFound: true })
      .mockResolvedValueOnce({ messages: [assistant('a-1', 'hello')] })

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    expect(latest?.status).toBe('loading')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(latest?.status).not.toBe('error')
    expect(transport.readSession).toHaveBeenCalledTimes(2)
    expect(latest?.messages.map((m) => m.id)).toContain('a-1')
  })

  it('surfaces an error once the ~60s retry window is exhausted', async () => {
    vi.useFakeTimers()
    const transport = getMockTransport('env-1', { autoSnapshot: false })
    transport.readSession.mockResolvedValue({ error: 'No transcript found', notFound: true })

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    expect(latest?.status).toBe('loading')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000)
    })

    expect(latest?.status).toBe('error')
    expect(latest?.error).toBe('No transcript found')
  })

  it('renders live-appended content instead of loading while the read is still retrying', async () => {
    vi.useFakeTimers()
    const transport = getMockTransport('env-1', { autoSnapshot: false })
    transport.readSession.mockResolvedValue({ error: 'No transcript found', notFound: true })

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    expect(latest?.status).toBe('loading')

    await act(async () => {
      transport.emit({ type: 'appended', messages: [assistant('a-early', 'landed during retry')] })
    })

    expect(latest?.status).not.toBe('loading')
    expect(latest?.messages.map((m) => m.id)).toContain('a-early')
  })

  it('renders live-appended content even when the initial read settled into a permanent error', async () => {
    const transport = getMockTransport('env-1', { autoSnapshot: false })
    transport.readSession.mockResolvedValueOnce({ error: 'unreadable transcript' })

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    expect(latest?.status).toBe('error')

    await act(async () => {
      transport.emit({ type: 'appended', messages: [assistant('a-late', 'landed late')] })
    })

    expect(latest?.status).not.toBe('error')
    expect(latest?.error).toBeUndefined()
    expect(latest?.messages.map((m) => m.id)).toContain('a-late')
  })
})
