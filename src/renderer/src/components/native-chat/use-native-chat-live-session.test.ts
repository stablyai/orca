// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useAppStore } from '@/store'
import { NATIVE_CHAT_INITIAL_LIMIT } from './native-chat-pagination'

// Mock the session transport so the hook's IO is observable and controllable
// per owner id. Each distinct owner gets its own read/subscribe/unsubscribe mocks.
const { transportFactory, getMockTransport, resetMockTransports } = vi.hoisted(() => {
  type MockTransport = {
    readSession: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
    emit: (frame: unknown) => void
  }
  const transports = new Map<string | null, MockTransport>()
  // autoSnapshot mirrors a watchable transcript's immediate first frame; pass
  // false to model a not-yet-flushed transcript whose server-side resolve poll
  // has nothing to emit yet (#8401) — only readSession drives the view then.
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
  getNativeChatSessionTransport: transportFactory,
  subscribeNativeChatSession: (
    transport: { subscribe: (...args: unknown[]) => unknown },
    args: unknown,
    onFrame: unknown
  ) => transport.subscribe(args, onFrame)
}))

// Imported after vi.mock is hoisted, so it binds to the mocked transport.
import {
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'

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

  it('seeds from readSession alongside the subscription for the initial runtime load', async () => {
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })

    expect(transportFactory).toHaveBeenCalledWith('env-1')
    const transport = getMockTransport('env-1')
    // The independent seed guards against a stuck 'loading' when the stream never
    // delivers a snapshot; a live snapshot still wins when it does (see below).
    expect(transport.readSession).toHaveBeenCalledOnce()
    expect(transport.subscribe).toHaveBeenCalledOnce()
  })

  it('re-subscribes against the new owner on an owner flip (R5)', async () => {
    const root = await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-1'
    })
    const first = getMockTransport('env-1')

    await rerender(root, {
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-2'
    })
    const second = getMockTransport('env-2')

    expect(first.unsubscribe).toHaveBeenCalledOnce()
    expect(second.subscribe).toHaveBeenCalledOnce()
  })

  it('tears down the subscription on unmount (no watcher leak)', async () => {
    const root = await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-1'
    })
    const transport = getMockTransport('env-1')

    await act(async () => {
      root.unmount()
    })

    expect(transport.unsubscribe).toHaveBeenCalledOnce()
  })

  it('surfaces a runtime snapshot error in the error phase (R4 end-to-end)', async () => {
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => {
      getMockTransport('env-1').emit({
        type: 'snapshot',
        messages: [],
        hasMore: false,
        error: 'runtime too old'
      })
    })

    expect(latest?.status).toBe('error')
    expect(latest?.error).toBe('runtime too old')
  })

  it('never calls the transport when there is no session id', async () => {
    await render({ paneKey: PANE, agent: AGENT, sessionId: null, runtimeEnvironmentId: 'env-1' })

    const transport = getMockTransport('env-1')
    expect(transport.readSession).not.toHaveBeenCalled()
    expect(transport.subscribe).not.toHaveBeenCalled()
  })

  it('uses the local transport when the owner is null (unchanged behavior, R6)', async () => {
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION })

    expect(transportFactory).toHaveBeenCalledWith(null)
    const transport = getMockTransport(null)
    expect(transport.readSession).toHaveBeenCalledOnce()
    expect(transport.subscribe).toHaveBeenCalledOnce()
  })

  it('discards a load-earlier resolve from the previous owner after a flip', async () => {
    // Fill the initial window so hasMore is true and load-earlier can fire.
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
    // Arm the pending read for load-earlier only; the initial seed already ran.
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    first.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    // Kick off load-earlier against env-1, then flip the owner before it resolves.
    await act(async () => {
      latest?.loadEarlier()
    })
    await rerender(root, {
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      runtimeEnvironmentId: 'env-2'
    })
    // The stale env-1 page resolves now; the transport-identity guard must drop it
    // so it can't paint the previous host's history into the env-2 pane.
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
    // Arm the pending read for load-earlier only; the initial seed already ran.
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    await act(async () => latest?.loadEarlier())

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
    // Arm the pending read for load-earlier only; the initial seed already ran.
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    await act(async () => latest?.loadEarlier())

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
    // Arm the pending read for load-earlier only; the initial seed already ran.
    let resolveEarlier: (result: { messages: NativeChatMessage[] }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveEarlier = resolve))
    )
    await act(async () => latest?.loadEarlier())

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
    // Older runtime: the stream wires only appends and stays silent for an empty
    // tail, so no snapshot arrives — the independent seed must settle the view.
    transport.subscribe.mockImplementation(() => transport.unsubscribe)
    transport.readSession.mockResolvedValueOnce({ messages: [user('u-seed', 'hi')] })

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })

    expect(latest?.status).not.toBe('loading')
    expect(latest?.messages.map((message) => message.id)).toEqual(['u-seed'])
  })

  it('keeps the live snapshot when a readSession seed resolves after it', async () => {
    const transport = getMockTransport('env-1')
    // The seed resolves only after the authoritative snapshot has already landed.
    let resolveSeed: (result: { messages: NativeChatMessage[] }) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSeed = resolve))
    )

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({ type: 'snapshot', messages: [user('u-live', 'live')], hasMore: false })
    )
    await act(async () => {
      resolveSeed({ messages: [user('u-stale', 'stale')] })
      await Promise.resolve()
    })

    expect(latest?.messages.map((message) => message.id)).toEqual(['u-live'])
  })

  it('orders only live appends after a non-adoption snapshot baseline', async () => {
    const transport = getMockTransport('env-1')
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('old', 'same')],
        hasMore: false
      })
    )
    const generation = latest?.transcriptOrder.generation
    expect(latest?.transcriptOrder.highWater).toBe(0)
    expect(latest?.transcriptOrder.messageSequenceById.has('old')).toBe(false)

    await act(async () =>
      transport.emit({
        type: 'appended',
        messages: [user('new-user', 'same'), assistant('new-answer', 'done')]
      })
    )

    expect(latest?.transcriptOrder).toMatchObject({ generation, highWater: 2 })
    expect(latest?.transcriptOrder.messageSequenceById.get('new-user')).toBe(1)
    expect(latest?.transcriptOrder.messageSequenceById.get('new-answer')).toBe(2)

    await act(async () =>
      transport.emit({
        type: 'replacement',
        messages: [user('replacement', 'fresh')],
        hasMore: false
      })
    )
    // Same-session replacement keeps generation and settles post-action rows.
    expect(latest?.transcriptOrder.generation).toBe(generation)
    expect(latest?.transcriptOrder.messageSequenceById.get('replacement')).toBe(3)
    expect(latest?.transcriptOrder.highWater).toBe(3)
  })

  it('null-session send then session metadata initial snapshot retires the pending turn', async () => {
    // Harness: null → send boundary capture → session id + path → mandatory snapshot.
    // Bad: snapshotVisible=[pending:p1], snapshotPruned=[p1]
    // Good: snapshot settles the first turn so visible/prune both drop p1.
    const root = await render({
      paneKey: PANE,
      agent: AGENT,
      sessionId: null,
      runtimeEnvironmentId: 'env-1'
    })
    const orderAtSend = latest?.transcriptOrder
    expect(orderAtSend).toMatchObject({ highWater: 0 })
    const pending = [
      {
        id: 'p1',
        text: 'hello first',
        sentAt: 100,
        afterMessageId: null as string | null,
        afterTranscriptGeneration: orderAtSend?.generation ?? 0,
        afterTranscriptHighWater: orderAtSend?.highWater ?? 0
      }
    ]

    await rerender(root, {
      paneKey: PANE,
      agent: AGENT,
      sessionId: SESSION,
      transcriptPath: '/host/transcript.jsonl',
      runtimeEnvironmentId: 'env-1'
    })
    // Adoption must not mint a new generation (pending still matches).
    expect(latest?.transcriptOrder.generation).toBe(orderAtSend?.generation)

    await act(async () =>
      getMockTransport('env-1').emit({
        type: 'snapshot',
        messages: [user('u1', 'hello first'), assistant('a1', 'hi')],
        hasMore: false
      })
    )

    const { pendingSendsAsMessages, prunePendingSends } = await import('./native-chat-pending')
    const snapshotVisible = pendingSendsAsMessages(
      pending,
      latest?.messages ?? [],
      latest?.transcriptOrder
    ).map((message) => message.id)
    const snapshotPruned = prunePendingSends(
      pending,
      latest?.messages ?? [],
      latest?.transcriptOrder
    ).map((entry) => entry.id)

    expect(latest?.transcriptOrder.messageSequenceById.get('u1')).toBe(1)
    expect(latest?.transcriptOrder.messageSequenceById.get('a1')).toBe(2)
    expect(snapshotVisible).toEqual([])
    expect(snapshotPruned).toEqual([])
  })

  it('same-session clear empty then replacement settles post-clear rows', async () => {
    // Harness: clear on empty → replacement with fresh rows.
    // Bad: visibleAfterClearReplacement=[]
    // Good: replacement-settled sequences are visible past the clear high-water.
    const transport = getMockTransport('env-1')
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => transport.emit({ type: 'snapshot', messages: [], hasMore: false }))
    const orderAtClear = latest?.transcriptOrder
    const clearMarkers = [
      {
        id: 'c1',
        command: '/clear',
        sentAt: 10,
        clearAfterMessageId: null as string | null,
        clearTranscriptGeneration: orderAtClear?.generation ?? 0,
        clearTranscriptHighWater: orderAtClear?.highWater ?? 0
      }
    ]

    await act(async () =>
      transport.emit({
        type: 'replacement',
        messages: [user('new-u', 'fresh'), assistant('new-a', 'ok')],
        hasMore: false
      })
    )

    const { applyCommandMarkerBoundaries } = await import('./native-chat-command-markers')
    const visibleAfterClearReplacement = applyCommandMarkerBoundaries(
      latest?.messages ?? [],
      clearMarkers,
      latest?.transcriptOrder
    ).map((message) => message.id)

    expect(latest?.transcriptOrder.generation).toBe(orderAtClear?.generation)
    expect(latest?.transcriptOrder.messageSequenceById.get('new-u')).toBe(1)
    expect(visibleAfterClearReplacement).toEqual(['new-u', 'new-a'])
  })

  it('same-session pagination does not sequence prepended baseline rows', async () => {
    const transport = getMockTransport('env-1')
    const many = Array.from({ length: NATIVE_CHAT_INITIAL_LIMIT }, (_unused, n) =>
      assistant(`m-${n}`, 't')
    )
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => transport.emit({ type: 'snapshot', messages: many, hasMore: true }))
    expect(latest?.transcriptOrder.highWater).toBe(0)

    await act(async () =>
      transport.emit({
        type: 'appended',
        messages: [user('live', 'go')]
      })
    )
    expect(latest?.transcriptOrder.messageSequenceById.get('live')).toBe(1)

    transport.readSession.mockResolvedValueOnce({
      messages: [assistant('older', 'page'), ...many, user('live', 'go')]
    })
    await act(async () => latest?.loadEarlier())
    await flush()

    // Pagination only replaces the base list; order stays append-settled.
    expect(latest?.transcriptOrder.messageSequenceById.get('live')).toBe(1)
    expect(latest?.transcriptOrder.messageSequenceById.has('older')).toBe(false)
    expect(latest?.messages.map((message) => message.id)).toContain('older')
  })

  it("self-heals a stale 'working' hook once the turn-complete marker lands", async () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: { state: 'working', stateStartedAt: 1 } as never }
    })
    const transport = getMockTransport('env-1')
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('u-1', 'go'), assistant('a-1', 'done')],
        hasMore: false,
        lifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 2 }
      })
    )

    expect(latest?.status).toBe('ready')
  })

  it('applies a lifecycle-only append after the final message frame', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: { state: 'working', stateStartedAt: 1 } as never }
    })
    const transport = getMockTransport('env-1')
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('u-1', 'go'), assistant('a-1', 'done')],
        hasMore: false,
        lifecycle: { state: 'working', turnId: 'turn-1', timestamp: 1 }
      })
    )
    expect(latest?.status).toBe('working')

    await act(async () =>
      transport.emit({
        type: 'appended',
        messages: [],
        lifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 2 }
      })
    )

    expect(latest?.status).toBe('ready')
  })

  it('applies a terminal-side interruption frame without a local Stop action', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: { state: 'working', stateStartedAt: 1 } as never }
    })
    const transport = getMockTransport('env-1')
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('u-1', 'go')],
        hasMore: false,
        lifecycle: { state: 'working', turnId: 'turn-1', timestamp: 1 }
      })
    )
    expect(latest?.status).toBe('working')

    await act(async () =>
      transport.emit({
        type: 'appended',
        messages: [],
        lifecycle: { state: 'interrupted', turnId: 'turn-1', timestamp: 2 }
      })
    )

    expect(latest?.status).toBe('ready')
  })

  it('does not let an older pagination read rewind a live completion', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: { state: 'working', stateStartedAt: 1 } as never }
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
    await act(async () => latest?.loadEarlier())
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

  it('reconciles completion from a reconnect snapshot', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: { state: 'working', stateStartedAt: 10 } as never }
    })
    const transport = getMockTransport('env-1')
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('u-1', 'go')],
        hasMore: false,
        lifecycle: { state: 'working', turnId: 'turn-1', timestamp: 10 }
      })
    )
    expect(latest?.status).toBe('working')

    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('u-1', 'go'), assistant('a-1', 'done')],
        hasMore: false,
        lifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 20 }
      })
    )

    expect(latest?.status).toBe('ready')
  })

  it('reconciles interruption from a reconnect snapshot', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: { state: 'working', stateStartedAt: 10 } as never }
    })
    const transport = getMockTransport('env-1')
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('u-1', 'go')],
        hasMore: false,
        lifecycle: { state: 'working', turnId: 'turn-1', timestamp: 10 }
      })
    )
    expect(latest?.status).toBe('working')

    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('u-1', 'go')],
        hasMore: false,
        lifecycle: { state: 'interrupted', turnId: 'turn-1', timestamp: 20 }
      })
    )

    expect(latest?.status).toBe('ready')
  })
})

// Regression for #8401: a just-created Claude Code session's transcript can
// take up to minutes to exist on disk, so the first readSession commonly
// misses. Before this fix, the hook settled into a permanent 'error' phase
// on that first miss and never recovered.
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

    // First backoff step (1s) fires the second readSession, which resolves.
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

    // The watcher's first drain lands mid-retry — content must win over the spinner.
    await act(async () => {
      transport.emit({ type: 'appended', messages: [assistant('a-early', 'landed during retry')] })
    })

    expect(latest?.status).not.toBe('loading')
    expect(latest?.messages.map((m) => m.id)).toContain('a-early')
  })

  it('still reports the loading readPhase once live content unmasks the status', async () => {
    // `status` is not a truthful read-in-flight signal: content landing
    // mid-retry outranks the spinner, so status leaves 'loading' while the read
    // is still in flight. The launch-draft baseline must never be snapshotted
    // on that partial list, so consumers need the raw phase instead.
    vi.useFakeTimers()
    const transport = getMockTransport('env-1', { autoSnapshot: false })
    transport.readSession.mockResolvedValue({ error: 'No transcript found', notFound: true })

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })

    // The user's own turn arrives on the watcher before the read settles.
    await act(async () => {
      transport.emit({ type: 'appended', messages: [user('u-live', 'hi')] })
    })

    expect(latest?.status).not.toBe('loading')
    expect(latest?.readPhase).toBe('loading')
  })

  // #11032 previously forced 'loading' whenever the session id was known, which
  // masked a live working hook. Unmasking it (so the composer offers Stop) adds
  // a second way status leaves 'loading' mid-read, so re-pin #9802's contract on
  // exactly that path: the launch-draft gate must still see the raw read phase.
  it('reports the loading readPhase for a known session whose working hook unmasks the status', async () => {
    vi.useFakeTimers()
    const transport = getMockTransport('env-1', { autoSnapshot: false })
    transport.readSession.mockResolvedValue({ error: 'No transcript found', notFound: true })
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: { state: 'working', stateStartedAt: 1 } }
    } as never)

    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })

    expect(latest?.status).toBe('working')
    expect(latest?.readPhase).toBe('loading')
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
