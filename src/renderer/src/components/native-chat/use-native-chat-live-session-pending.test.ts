// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useAppStore } from '@/store'

const { resetTransport, subscriptions, transport } = vi.hoisted(() => {
  const subscriptions: { onFrame: (frame: unknown) => void }[] = []
  const transport = { readSession: vi.fn(), subscribe: vi.fn() }
  const resetTransport = (): void => {
    subscriptions.splice(0)
    // Default to an in-flight read so only the frames a test emits move the view.
    transport.readSession.mockReset().mockImplementation(() => new Promise(() => {}))
    transport.subscribe.mockReset().mockImplementation((_args, onFrame) => {
      subscriptions.push({ onFrame })
      return vi.fn()
    })
  }
  return { resetTransport, subscriptions, transport }
})

vi.mock('./native-chat-session-transport', () => ({
  getNativeChatSessionTransport: () => transport
}))

import {
  isNativeChatTranscriptUnsettled,
  NOTFOUND_RETRY_WINDOW_MS,
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'

const BASE_ARGS: UseNativeChatLiveSessionArgs = {
  paneKey: 'tab-1:leaf-1',
  agent: 'claude',
  sessionId: 'session-1',
  transcriptPath: '/home/agent/session-1.jsonl',
  enabled: true
}

/** The frame the host emits once it has waited out the flush grace period. */
const PENDING_FRAME = { type: 'snapshot', messages: [], hasMore: false, pending: true }

function assistant(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('useNativeChatLiveSession — unflushed transcript (pending frame)', () => {
  let root: Root
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatLiveSession(props)
    return null
  }

  async function render(props: UseNativeChatLiveSessionArgs = BASE_ARGS): Promise<void> {
    await act(async () => {
      root.render(createElement(Probe, props))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function emit(frame: unknown): Promise<void> {
    await act(async () => {
      subscriptions[0]?.onFrame(frame)
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    root = createRoot(document.createElement('div'))
    latest = null
    resetTransport()
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it('spins while neither the read nor the stream has produced anything', async () => {
    await render()

    expect(latest?.readPhase).toBe('loading')
    expect(latest?.status).toBe('loading')
  })

  it('leaves the loading surface on a pending frame without claiming a settled read', async () => {
    await render()

    await emit(PENDING_FRAME)

    expect(latest?.readPhase).toBe('awaiting')
    expect(latest?.status).not.toBe('loading')
    expect(latest?.status).not.toBe('error')
    expect(latest?.messages).toEqual([])
  })

  it('keeps the readSession seed live, so the real transcript still backfills', async () => {
    // The seed is the only thing that repairs the pane when the flush lands
    // between the stream's initial drain and its next event — a pending frame
    // must not consume it the way a real snapshot does.
    let settleRead = (_result: { messages: NativeChatMessage[] }): void => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (settleRead = resolve))
    )
    await render()

    await emit(PENDING_FRAME)
    await act(async () => {
      settleRead({ messages: [assistant('flushed-later')] })
      await Promise.resolve()
    })

    expect(latest?.readPhase).toBe('ready')
    expect(latest?.messages.map((message) => message.id)).toEqual(['flushed-later'])
  })

  it('settles to ready when the real snapshot arrives on the same subscription', async () => {
    await render()

    await emit(PENDING_FRAME)
    await emit({ type: 'snapshot', messages: [assistant('m-1')], hasMore: false })

    expect(latest?.readPhase).toBe('ready')
    expect(latest?.messages.map((message) => message.id)).toEqual(['m-1'])
  })

  it('errors once the not-found window expires with no word from the host', async () => {
    // Control for the next case: proves the clock really drives the retry loop,
    // so a passing suppression test can't be the timers never firing.
    vi.useFakeTimers()
    transport.readSession.mockResolvedValue({ error: 'no transcript', notFound: true })
    await render()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTFOUND_RETRY_WINDOW_MS + 30_000)
    })

    expect(latest?.readPhase).toBe('error')
  })

  it('stops duplicate seed polling once the live stream owns the pending transcript', async () => {
    // The reported bug: a tab that is never prompted never writes a transcript, so
    // every read is notFound forever. The host has told us that is expected.
    vi.useFakeTimers()
    let settleRead = (_result: { error: string; notFound: true }): void => {}
    transport.readSession.mockImplementationOnce(
      () => new Promise((resolve) => (settleRead = resolve))
    )
    await render()

    await emit(PENDING_FRAME)
    await act(async () => {
      settleRead({ error: 'no transcript', notFound: true })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(NOTFOUND_RETRY_WINDOW_MS + 30_000)
    })

    expect(latest?.readPhase).toBe('awaiting')
    expect(latest?.status).not.toBe('error')
    // The resolve-poll subscription owns the eventual initial drain; continuing
    // the seed too would issue one redundant filesystem read every 10 seconds.
    expect(transport.readSession).toHaveBeenCalledOnce()
  })

  it('does not drop live appends already merged into the window', async () => {
    await render()

    await emit({ type: 'appended', messages: [assistant('appended-1')] })
    await emit(PENDING_FRAME)

    expect(latest?.readPhase).toBe('awaiting')
    expect(latest?.messages.map((message) => message.id)).toEqual(['appended-1'])
  })
})

describe('useNativeChatRetainedSession — unflushed transcript', () => {
  let root: Root
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatRetainedSession(props)
    return null
  }

  async function emit(frame: unknown): Promise<void> {
    await act(async () => {
      subscriptions[0]?.onFrame(frame)
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    root = createRoot(document.createElement('div'))
    latest = null
    resetTransport()
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it('retains committed history instead of capturing the empty pending window', async () => {
    await act(async () => {
      root.render(createElement(Probe, BASE_ARGS))
      await Promise.resolve()
      await Promise.resolve()
    })
    await emit({ type: 'snapshot', messages: [assistant('committed')], hasMore: false })

    await emit(PENDING_FRAME)

    expect(latest?.readPhase).toBe('awaiting')
    expect(latest?.messages.map((message) => message.id)).toEqual(['committed'])
  })
})

describe('isNativeChatTranscriptUnsettled', () => {
  it('covers both unsettled phases and neither settled one', () => {
    // The launch-draft gate in NativeChatView reads this: treating 'awaiting' as
    // settled would re-offer a prefill the user already submitted.
    expect(isNativeChatTranscriptUnsettled('loading')).toBe(true)
    expect(isNativeChatTranscriptUnsettled('awaiting')).toBe(true)
    expect(isNativeChatTranscriptUnsettled('ready')).toBe(false)
    expect(isNativeChatTranscriptUnsettled('error')).toBe(false)
  })
})
