// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  NATIVE_CHAT_REMOTE_DEFAULT_WINDOW,
  NATIVE_CHAT_REMOTE_MAX_WINDOW
} from '../../../../shared/native-chat-types'
import { useAppStore } from '@/store'
import { NATIVE_CHAT_PAGE } from './native-chat-pagination'

// Same transport double as the sibling live-session suites: the hook's IO is the
// only thing under test here, so subscribe stays silent and readSession drives.
const { transportFactory, getMockTransport, resetMockTransports } = vi.hoisted(() => {
  type MockTransport = {
    readSession: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
    emit: (frame: unknown) => void
  }
  const transports = new Map<string | null, MockTransport>()
  const getMockTransport = (ownerId: string | null): MockTransport => {
    let transport = transports.get(ownerId)
    if (!transport) {
      const unsubscribe = vi.fn()
      let listener: (frame: unknown) => void = () => {}
      transport = {
        unsubscribe,
        readSession: vi.fn().mockResolvedValue({ messages: [] }),
        subscribe: vi.fn((_args, onFrame) => {
          listener = onFrame
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

import {
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'

// Timestamps track file position so an older page is genuinely older, the way a
// real transcript's records are.
function page(prefix: string, count: number, startOffset = 0): NativeChatMessage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text: 't' }],
    timestamp: startOffset + index + 1,
    source: 'transcript' as const
  }))
}

// XLR-R1-001: growing `limit` stops making progress at the wire ceiling. Without
// offset continuation every later load-earlier re-requests the same 2,000-record
// tail, keeps the 'filled' verdict, and the records behind it are unreachable.
describe('useNativeChatLiveSession — paging past the read-window ceiling', () => {
  const AGENT = 'claude' as const
  const PANE = 'tab-1:leaf-1'
  const SESSION = 'session-1'
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

  async function render(): Promise<void> {
    const container = document.createElement('div')
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        createElement(Probe, {
          paneKey: PANE,
          agent: AGENT,
          sessionId: SESSION,
          runtimeEnvironmentId: 'env-1'
        })
      )
    })
    await flush()
  }

  async function loadEarlier(): Promise<void> {
    await act(async () => {
      latest?.loadEarlier()
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

  /** A transcript deeper than any window: every read fills what it asked for and
   *  reports the byte offset of its oldest record, exactly as the host does. */
  function mockDeepTranscript(transport: ReturnType<typeof getMockTransport>): void {
    const FILE_END = 1_000_000
    transport.readSession.mockImplementation(
      async (
        _agent: unknown,
        _sessionId: unknown,
        limit: number,
        _transcriptPath: unknown,
        beforeOffset?: number
      ) => {
        const end = beforeOffset ?? FILE_END
        return { messages: page(`at-${end}`, limit, end - limit), beforeOffset: end - limit }
      }
    )
  }

  /** Page back until the tail limit saturates at the ceiling. */
  async function pageToCeiling(transport: ReturnType<typeof getMockTransport>): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const requestedLimit = transport.readSession.mock.lastCall?.[2] as number | undefined
      if (requestedLimit === NATIVE_CHAT_REMOTE_MAX_WINDOW) {
        return
      }
      await loadEarlier()
    }
    throw new Error('never reached the read-window ceiling')
  }

  it('continues by byte offset instead of re-requesting the same saturated tail', async () => {
    const transport = getMockTransport('env-1')
    mockDeepTranscript(transport)
    await render()
    await pageToCeiling(transport)

    const saturated = transport.readSession.mock.lastCall
    expect(saturated?.[2]).toBe(NATIVE_CHAT_REMOTE_MAX_WINDOW)
    expect(saturated?.[4]).toBeUndefined()
    const loadedAtCeiling = latest?.messages.length ?? 0
    expect(loadedAtCeiling).toBe(NATIVE_CHAT_REMOTE_MAX_WINDOW)
    expect(latest?.hasMore).toBe(true)

    await loadEarlier()

    // The dead end: before the fix this repeated the identical ceiling-wide tail
    // read, so nothing older could ever be reached.
    const continued = transport.readSession.mock.lastCall
    expect(continued?.[2]).toBe(NATIVE_CHAT_PAGE)
    expect(continued?.[4]).toBe(1_000_000 - NATIVE_CHAT_REMOTE_MAX_WINDOW)
    // The continuation page is older than the loaded window, so it prepends.
    expect(latest?.messages.length).toBe(loadedAtCeiling + NATIVE_CHAT_PAGE)
    expect(latest?.messages[0]?.id).toBe(`at-${1_000_000 - NATIVE_CHAT_REMOTE_MAX_WINDOW}-0`)

    await loadEarlier()

    // And it keeps walking back rather than pinning on one cursor.
    expect(transport.readSession.mock.lastCall?.[4]).toBe(
      1_000_000 - NATIVE_CHAT_REMOTE_MAX_WINDOW - NATIVE_CHAT_PAGE
    )
    expect(latest?.messages.length).toBe(loadedAtCeiling + 2 * NATIVE_CHAT_PAGE)
  })

  it('withdraws load-earlier once a continuation page reaches the transcript head', async () => {
    const transport = getMockTransport('env-1')
    mockDeepTranscript(transport)
    await render()
    await pageToCeiling(transport)

    // A short page is the transcript head: there is nothing older to ask for.
    transport.readSession.mockResolvedValueOnce({ messages: page('head', 5, 0), beforeOffset: 0 })
    await loadEarlier()

    expect(latest?.hasMore).toBe(false)
    const callsAtHead = transport.readSession.mock.calls.length
    await loadEarlier()
    expect(transport.readSession.mock.calls.length).toBe(callsAtHead)
  })

  // XLR-R8-002 (cross-lab review, round 8): growth saturates at the ceiling and
  // a host that reports no cursor leaves nothing to anchor a continuation to, so
  // every later request is byte-identical to this one. Load-earlier stayed
  // enabled through all of them and the older records were never reachable.
  it('retires load-earlier when the ceiling-wide read still reports no cursor', async () => {
    const transport = getMockTransport('env-1')
    transport.readSession.mockImplementation(
      async (_agent: unknown, _sessionId: unknown, limit: number) => ({
        messages: page(`legacy-${limit}`, limit)
      })
    )
    await render()
    // Growth itself is untouched: the widening tail reads all the way to the
    // ceiling are real progress on a host that honors the limit.
    await pageToCeiling(transport)

    expect(transport.readSession.mock.lastCall?.[2]).toBe(NATIVE_CHAT_REMOTE_MAX_WINDOW)
    expect(transport.readSession.mock.lastCall?.[4]).toBeUndefined()
    expect(latest?.hasMore).toBe(false)

    const callsAtCeiling = transport.readSession.mock.calls.length
    await loadEarlier()
    expect(transport.readSession.mock.calls.length).toBe(callsAtCeiling)
  })

  // XLR-R3-003 (cross-lab review, round 3): a host that predates the
  // client-supplied `limit` answers every request with its own fixed 40-record
  // window and reports no `hasMore`. Grading that against the 300-record
  // request called it the transcript head, so Load-earlier was withdrawn for
  // the whole session with older records still on disk.
  // XLR-R8-002 extends it: the seed's over-offer buys exactly ONE read. When
  // that read comes back with the same fixed window for a far larger request,
  // neither a wider limit nor a cursor can reach further back, so the control
  // retires instead of reissuing the identical request for the rest of the
  // session (limit climbing to the ceiling and then repeating forever).
  it('offers load-earlier once on a legacy host, then retires it when the read proves useless', async () => {
    const transport = getMockTransport('env-1')
    transport.readSession.mockImplementation(async () => ({
      messages: page('legacy', NATIVE_CHAT_REMOTE_DEFAULT_WINDOW)
    }))
    await render()

    expect(latest?.messages.length).toBe(NATIVE_CHAT_REMOTE_DEFAULT_WINDOW)
    expect(latest?.hasMore).toBe(true)

    const callsBefore = transport.readSession.mock.calls.length
    await loadEarlier()
    expect(transport.readSession.mock.calls.length).toBe(callsBefore + 1)
    expect(latest?.hasMore).toBe(false)

    // The spin the finding describes: without the withdrawal every further
    // click reissued the same read and the limit walked up to the ceiling.
    await loadEarlier()
    await loadEarlier()
    expect(transport.readSession.mock.calls.length).toBe(callsBefore + 1)
  })

  // The other half: a host that DOES measure is still believed, so a pane that
  // really is at the head keeps withdrawing the control.
  it('withdraws load-earlier on a seed read the host measured as complete', async () => {
    const transport = getMockTransport('env-1')
    transport.readSession.mockResolvedValue({
      messages: page('all', NATIVE_CHAT_REMOTE_DEFAULT_WINDOW),
      hasMore: false
    })
    await render()

    expect(latest?.hasMore).toBe(false)
  })

  it('drops the cursor when an authoritative frame replaces the window', async () => {
    const transport = getMockTransport('env-1')
    mockDeepTranscript(transport)
    await render()
    await pageToCeiling(transport)

    // A reconnect snapshot repaints a narrower window; continuing from the old
    // cursor would prepend a page with a hole between it and this one.
    await act(async () => {
      transport.emit({ type: 'snapshot', messages: page('snap', 10, 999_000), hasMore: true })
    })
    await flush()
    await loadEarlier()

    expect(transport.readSession.mock.lastCall?.[4]).toBeUndefined()
  })
})
