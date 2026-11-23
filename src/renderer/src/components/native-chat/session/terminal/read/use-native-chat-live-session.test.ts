import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
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
    useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})) })
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
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({
          [PANE]: {
            paneKey: PANE,
            state: 'working' as const,
            prompt: 'task',
            stateStartedAt: 1,
            updatedAt: Date.now(),
            stateHistory: []
          }
        })
      )
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

  it('pages older history by cursor and prepends it to the held window', async () => {
    const transport = Object.assign(getMockTransport('env-1'), { pagesByCursor: true })
    const at = (id: string, offset: number) => ({ ...assistant(id, 't'), transcriptOrder: offset })
    const held = Array.from({ length: 300 }, (_unused, n) => at(`held-${n}`, 1000 + n))
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => transport.emit({ type: 'snapshot', messages: held, hasMore: true }))
    transport.readSession.mockResolvedValueOnce({
      messages: [at('older-0', 10), at('older-1', 20)],
      hasMore: false,
      beforeOffset: 10
    })

    let result: unknown
    await act(async () => {
      result = await latest?.loadEarlier()
    })

    expect(transport.readSession).toHaveBeenLastCalledWith(AGENT, SESSION, 200, undefined, {
      wakeWslDistro: true,
      beforeOffset: 1000
    })
    expect(result).toBe('applied')
    expect(latest?.messages.slice(0, 3).map((m) => m.id)).toEqual(['older-0', 'older-1', 'held-0'])
    expect(latest?.hasMore).toBe(false)
  })

  it('rereads a held prefix after a same-size rewrite outside the replacement window', async () => {
    vi.useFakeTimers()
    try {
      const transport = Object.assign(getMockTransport('env-1'), {
        pagesByCursor: true,
        verifyTranscriptRanges: vi.fn().mockResolvedValue([false])
      })
      const rows = Array.from({ length: 500 }, (_, n) => ({
        ...user(`row-${n}`, n === 100 ? 'stale text' : `text-${n}`),
        transcriptOrder: n
      }))
      const ranges = [{ start: 200, end: 500, digest: '0000000000000300' }]
      await render({
        paneKey: PANE,
        agent: AGENT,
        sessionId: SESSION,
        runtimeEnvironmentId: 'env-1'
      })
      await act(async () =>
        transport.emit({ type: 'snapshot', messages: rows.slice(200), hasMore: true, ranges })
      )
      transport.readSession.mockResolvedValueOnce({
        messages: rows.slice(0, 200),
        hasMore: true,
        ranges: [{ start: 0, end: 200, digest: '0000000000000200' }]
      })
      await act(async () => {
        await latest?.loadEarlier()
      })
      transport.readSession.mockResolvedValueOnce({
        messages: rows.map((row) =>
          row.id === 'row-100' ? { ...row, blocks: [{ type: 'text', text: 'fresh text' }] } : row
        ),
        hasMore: false,
        ranges: [{ start: 0, end: 500, digest: '0000000000000501' }]
      })
      await act(async () =>
        transport.emit({ type: 'replacement', messages: rows.slice(200), hasMore: true, ranges })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(latest?.messages).toHaveLength(500)
      expect(latest?.messages.find((row) => row.id === 'row-100')?.blocks).toEqual([
        { type: 'text', text: 'fresh text' }
      ])
      expect(JSON.stringify(latest?.messages)).not.toContain('stale text')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-reads again when appends during a re-read leave the live tail past its end', async () => {
    vi.useFakeTimers()
    try {
      const transport = Object.assign(getMockTransport('env-1'), {
        pagesByCursor: true,
        verifyTranscriptRanges: vi.fn().mockResolvedValue([false])
      })
      const rows = Array.from({ length: 500 }, (_, n) => ({
        ...user(`row-${n}`, n === 100 ? 'stale text' : `text-${n}`),
        transcriptOrder: n
      }))
      const live = Array.from({ length: 700 }, (_, n) => ({
        ...assistant(`live-${500 + n}`, 't'),
        transcriptOrder: 500 + n
      }))
      const fresh = rows.map((row) =>
        row.id === 'row-100' ? { ...row, blocks: [{ type: 'text', text: 'fresh text' }] } : row
      )
      const ranges = [{ start: 200, end: 500, digest: '0000000000000300' }]
      await render({
        paneKey: PANE,
        agent: AGENT,
        sessionId: SESSION,
        runtimeEnvironmentId: 'env-1'
      })
      await act(async () =>
        transport.emit({ type: 'snapshot', messages: rows.slice(200), hasMore: true, ranges })
      )
      transport.readSession.mockResolvedValueOnce({
        messages: rows.slice(0, 200),
        hasMore: true,
        ranges: [{ start: 0, end: 200, digest: '0000000000000200' }]
      })
      await act(async () => {
        await latest?.loadEarlier()
      })
      let resolveReread: (result: unknown) => void = () => {}
      transport.readSession.mockImplementationOnce(
        () => new Promise((resolve) => (resolveReread = resolve))
      )
      await act(async () =>
        transport.emit({ type: 'replacement', messages: rows.slice(200), hasMore: true, ranges })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      await act(async () => transport.emit({ type: 'appended', messages: live }))
      transport.readSession.mockResolvedValueOnce({
        messages: [...fresh, ...live],
        hasMore: false,
        ranges: [{ start: 0, end: 1200, digest: '0000000000001200' }]
      })
      await act(async () => {
        resolveReread({
          messages: fresh,
          hasMore: false,
          ranges: [{ start: 0, end: 500, digest: '0000000000000501' }]
        })
        await vi.advanceTimersByTimeAsync(2_000)
      })
      const ids = latest?.messages.map((row) => row.id) ?? []
      expect(ids).toContain('live-550')
      expect(ids).toContain('live-1199')
      expect(latest?.messages.find((row) => row.id === 'row-100')?.blocks).toEqual([
        { type: 'text', text: 'fresh text' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps all held rows when a touch-only replacement verifies', async () => {
    vi.useFakeTimers()
    try {
      const transport = Object.assign(getMockTransport('env-1'), {
        pagesByCursor: true,
        verifyTranscriptRanges: vi.fn().mockResolvedValue([true])
      })
      const rows = Array.from({ length: 500 }, (_, n) => ({
        ...user(`row-${n}`, `text-${n}`),
        transcriptOrder: n
      }))
      const ranges = [{ start: 200, end: 500, digest: '0000000000000300' }]
      await render({
        paneKey: PANE,
        agent: AGENT,
        sessionId: SESSION,
        runtimeEnvironmentId: 'env-1'
      })
      await act(async () =>
        transport.emit({ type: 'snapshot', messages: rows.slice(200), hasMore: true, ranges })
      )
      transport.readSession.mockResolvedValueOnce({
        messages: rows.slice(0, 200),
        hasMore: true,
        ranges: [{ start: 0, end: 200, digest: '0000000000000200' }]
      })
      await act(async () => {
        await latest?.loadEarlier()
      })
      await act(async () =>
        transport.emit({
          type: 'replacement',
          messages: rows.slice(200).map((row) => ({ ...row })),
          hasMore: true,
          ranges
        })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(latest?.messages).toHaveLength(500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the held base bounded while replacements slide the window forward', async () => {
    const transport = Object.assign(getMockTransport('env-1'), {
      pagesByCursor: true,
      verifyTranscriptRanges: vi.fn().mockResolvedValue([true])
    })
    const rows = Array.from({ length: 1_300 }, (_, n) => ({
      ...user(`row-${n}`, `text-${n}`),
      transcriptOrder: n
    }))
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () =>
      transport.emit({ type: 'snapshot', messages: rows.slice(0, 300), hasMore: true })
    )
    for (let k = 1; k <= 1_000; k++) {
      await act(async () =>
        transport.emit({ type: 'replacement', messages: rows.slice(k, k + 300), hasMore: true })
      )
    }
    expect(latest?.messages).toHaveLength(900)
    expect(latest?.messages.at(-1)?.id).toBe('row-1299')
    expect(latest?.hasMore).toBe(true)
  })

  it('keeps the held base bounded when repairs run between sliding replacements', async () => {
    vi.useFakeTimers()
    try {
      const rows = Array.from({ length: 3_000 }, (_, n) => ({
        ...user(`row-${n}`, `text-${n}`),
        transcriptOrder: n
      }))
      const transport = Object.assign(getMockTransport('env-1'), {
        pagesByCursor: true,
        verifyTranscriptRanges: vi.fn().mockResolvedValue([false])
      })
      let end = 300
      transport.readSession.mockImplementation(async (_agent, _session, limit, _path, options) => {
        const before = Math.min(options?.beforeOffset ?? end, end)
        const start = Math.max(0, before - (limit ?? 300))
        return {
          messages: rows.slice(start, before),
          hasMore: start > 0,
          ranges: [{ start, end: before, digest: '0000000000000001' }]
        }
      })
      await render({
        paneKey: PANE,
        agent: AGENT,
        sessionId: SESSION,
        runtimeEnvironmentId: 'env-1'
      })
      await act(async () =>
        transport.emit({
          type: 'snapshot',
          messages: rows.slice(0, 300),
          hasMore: true,
          ranges: [{ start: 0, end: 300, digest: '0000000000000001' }]
        })
      )
      for (end = 307; end <= 2_400; end += 7) {
        await act(async () =>
          transport.emit({
            type: 'replacement',
            messages: rows.slice(end - 300, end),
            hasMore: true,
            ranges: [{ start: end - 300, end, digest: '0000000000000001' }]
          })
        )
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_100)
        })
      }
      expect(latest?.messages.length).toBeLessThanOrEqual(900)
      expect(latest?.messages.at(-1)?.id).toBe('row-2399')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets paged-in history when a host without verification re-sends the window', async () => {
    const transport = Object.assign(getMockTransport('env-1'), { pagesByCursor: true })
    const at = (id: string, offset: number) => ({ ...assistant(id, 't'), transcriptOrder: offset })
    const held = Array.from({ length: 300 }, (_unused, n) => at(`held-${n}`, 1000 + n))
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => transport.emit({ type: 'snapshot', messages: held, hasMore: true }))
    transport.readSession.mockResolvedValueOnce({
      messages: [at('older-0', 10), at('older-1', 20)],
      hasMore: true,
      beforeOffset: 10
    })
    await act(async () => {
      await latest?.loadEarlier()
    })

    const reply = at('reply', 1300)
    await act(async () =>
      transport.emit({ type: 'replacement', messages: [...held.slice(1), reply], hasMore: true })
    )

    expect(latest?.messages.slice(0, 3).map((m) => m.id)).toEqual(['held-1', 'held-2', 'held-3'])
    expect(latest?.messages.at(-1)?.id).toBe('reply')
    expect(latest?.hasMore).toBe(true)
  })

  it('keeps paged-in history when the re-sent window starts inside the live tail', async () => {
    const transport = Object.assign(getMockTransport('env-1'), {
      pagesByCursor: true,
      verifyTranscriptRanges: vi.fn().mockResolvedValue([true])
    })
    const at = (id: string, offset: number) => ({ ...assistant(id, 't'), transcriptOrder: offset })
    const held = Array.from({ length: 300 }, (_unused, n) => at(`held-${n}`, 1000 + n))
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => transport.emit({ type: 'snapshot', messages: held, hasMore: true }))
    transport.readSession.mockResolvedValueOnce({
      messages: [at('older-0', 10), at('older-1', 20)],
      hasMore: true,
      beforeOffset: 10
    })
    await act(async () => {
      await latest?.loadEarlier()
    })
    const live = Array.from({ length: 301 }, (_unused, n) => at(`live-${n}`, 2000 + n))
    await act(async () => transport.emit({ type: 'appended', messages: live }))

    await act(async () =>
      transport.emit({ type: 'replacement', messages: live.slice(1), hasMore: true })
    )

    const ids = latest?.messages.map((m) => m.id) ?? []
    expect(ids.slice(0, 3)).toEqual(['older-0', 'older-1', 'held-0'])
    expect(ids.slice(301, 304)).toEqual(['held-299', 'live-0', 'live-1'])
    expect(ids).toHaveLength(603)
    expect(new Set(ids).size).toBe(603)
  })

  it('resets to a re-sent window that proves nothing older exists', async () => {
    const transport = Object.assign(getMockTransport('env-1'), { pagesByCursor: true })
    const at = (id: string, offset: number) => ({ ...assistant(id, 't'), transcriptOrder: offset })
    const held = Array.from({ length: 300 }, (_unused, n) => at(`held-${n}`, 1000 + n))
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => transport.emit({ type: 'snapshot', messages: held, hasMore: true }))
    transport.readSession.mockResolvedValueOnce({
      messages: [at('older-0', 10), at('older-1', 20)],
      hasMore: true,
      beforeOffset: 10
    })
    await act(async () => {
      await latest?.loadEarlier()
    })

    await act(async () =>
      transport.emit({ type: 'replacement', messages: held.slice(1), hasMore: false })
    )

    expect(latest?.messages[0]?.id).toBe('held-1')
    expect(latest?.hasMore).toBe(false)
  })

  it('rereads when appends evict the live overlap while a cursor page is in flight', async () => {
    const transport = Object.assign(getMockTransport('env-1'), { pagesByCursor: true })
    const at = (id: string, offset: number) => ({ ...assistant(id, 't'), transcriptOrder: offset })
    const held = Array.from({ length: 300 }, (_unused, n) => at(`held-${n}`, 1000 + n))
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => transport.emit({ type: 'snapshot', messages: held, hasMore: true }))
    let resolvePage: (result: unknown) => void = () => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePage = resolve))
    )
    let pending: Promise<unknown> | undefined
    await act(async () => {
      pending = latest?.loadEarlier()
    })
    const live = Array.from({ length: 301 }, (_unused, n) => at(`live-${n}`, 5000 + n))
    await act(async () => transport.emit({ type: 'appended', messages: live }))

    await act(async () => {
      resolvePage({ messages: [at('older-0', 10)], hasMore: false })
      await pending
    })

    expect(transport.readSession).toHaveBeenLastCalledWith(AGENT, SESSION, 500, undefined, {
      wakeWslDistro: true
    })
    expect(latest?.messages.map((m) => m.id)).not.toContain('older-0')
  })

  it('repairs a live-tail gap with a full reread, then resumes cursor paging', async () => {
    const transport = Object.assign(getMockTransport('env-1'), { pagesByCursor: true })
    const at = (id: string, offset: number) => ({ ...assistant(id, 't'), transcriptOrder: offset })
    const held = Array.from({ length: 300 }, (_unused, n) => at(`held-${n}`, 1000 + n))
    await render({ paneKey: PANE, agent: AGENT, sessionId: SESSION, runtimeEnvironmentId: 'env-1' })
    await act(async () => transport.emit({ type: 'snapshot', messages: held, hasMore: true }))
    // 301 appends push the bounded live tail past live-0, leaving a gap after held-299.
    const live = Array.from({ length: 301 }, (_unused, n) => at(`live-${n}`, 5000 + n))
    await act(async () => transport.emit({ type: 'appended', messages: live }))
    expect(latest?.messages.map((m) => m.id)).not.toContain('live-0')
    const bridge = Array.from({ length: 199 }, (_unused, n) => at(`bridge-${n}`, 4700 + n))
    transport.readSession.mockResolvedValueOnce({ messages: [...bridge, ...live] })

    await act(async () => {
      await latest?.loadEarlier()
    })

    expect(transport.readSession).toHaveBeenLastCalledWith(AGENT, SESSION, 500, undefined, {
      wakeWslDistro: true
    })
    expect(latest?.messages.map((m) => m.id)).toContain('live-0')

    transport.readSession.mockResolvedValueOnce({ messages: [], hasMore: false })
    await act(async () => {
      await latest?.loadEarlier()
    })

    expect(transport.readSession).toHaveBeenLastCalledWith(AGENT, SESSION, 200, undefined, {
      wakeWslDistro: true,
      beforeOffset: 4700
    })
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
    useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})) })
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
