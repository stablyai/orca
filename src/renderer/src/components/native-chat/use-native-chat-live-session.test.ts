// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useAppStore } from '@/store'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
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
  getNativeChatSessionTransport: transportFactory
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

describe('mergeNativeChatLiveSession', () => {
  it("surfaces live 'working' before the assistant turn lands in the transcript", () => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [user('u-1', 'do a thing')] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working'
    })
    expect(session.status).toBe('working')
    expect(session.messages).toHaveLength(1)
  })

  it("keeps 'working' authoritative when a prior assistant message is present", () => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [user('u-1', 'do a thing'), assistant('a-1', 'done')] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working'
    })
    expect(session.status).toBe('working')
  })

  it("self-heals a stale 'working' once this turn's assistant reply lands", () => {
    // Trailing assistant reply (ts 2) post-dates the working turn's start (ts 1),
    // so a dropped/late Stop hook must not strand 'working' on a visible reply.
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [user('u-1', 'go'), assistant('a-1', 'done')] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 1
    })
    expect(session.status).toBe('ready')
  })

  it("keeps 'working' when the trailing assistant reply predates the working turn", () => {
    // Trailing reply (ts 2) is older than the new working turn (started at ts 5),
    // so the agent is working again — the stale reply must not suppress 'working'.
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [user('u-1', 'go'), assistant('a-1', 'prior')] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 5
    })
    expect(session.status).toBe('working')
  })

  it('leaves completed states (done/waiting/blocked) on the derived status', () => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [user('u-1', 'hi')] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'done'
    })
    expect(session.status).toBe('ready')
  })

  it('honors loading and error overrides outright', () => {
    expect(
      mergeNativeChatLiveSession({
        sources: { transcript: [] },
        sessionId: null,
        agent: 'claude',
        hookState: 'working',
        loading: true
      }).status
    ).toBe('loading')

    const errored = mergeNativeChatLiveSession({
      sources: { transcript: [] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: null,
      error: 'unreadable'
    })
    expect(errored.status).toBe('error')
    expect(errored.error).toBe('unreadable')
  })

  it('assembles an empty transcript with no live work as empty', () => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: null
    })
    expect(session.status).toBe('empty')
  })
})

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

  it("self-heals a stale 'working' hook once this turn's reply has landed", async () => {
    // The hook must read stateStartedAt from the store and thread it into the
    // merge, so a dropped Stop hook doesn't strand 'Agent is working'.
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: { state: 'working', stateStartedAt: 1 } as never }
    })
    const transport = getMockTransport('env-1')
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({
        type: 'snapshot',
        messages: [user('u-1', 'go'), assistant('a-1', 'done')],
        hasMore: false
      })
    )

    // The reply (ts 2) post-dates stateStartedAt (1): the stuck 'working' heals.
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
