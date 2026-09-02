// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  NativeChatLiveSession,
  UseNativeChatLiveSessionArgs
} from './use-native-chat-live-session'

const { liveSession } = vi.hoisted(() => ({ liveSession: vi.fn() }))

vi.mock('./use-native-chat-live-session', () => ({ useNativeChatLiveSession: liveSession }))

import { useNativeChatRetainedSession } from './use-native-chat-retained-session'

const ARGS: UseNativeChatLiveSessionArgs = {
  paneKey: 'tab:leaf',
  agent: 'claude',
  sessionId: 'session',
  runtimeEnvironmentId: 'owner-a'
}

function message(id: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [], timestamp: 0, source: 'transcript' }
}

function session(
  readPhase: NativeChatLiveSession['readPhase'],
  messages: NativeChatMessage[],
  sessionId: string | null = 'session'
): NativeChatLiveSession {
  return {
    agent: 'claude',
    sessionId,
    messages,
    status: readPhase === 'loading' ? 'loading' : 'ready',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase
  }
}

describe('useNativeChatRetainedSession', () => {
  let root: Root | null = null
  let latest: NativeChatLiveSession | null = null

  function Probe(props: UseNativeChatLiveSessionArgs): null {
    latest = useNativeChatRetainedSession(props)
    return null
  }

  async function render(props: UseNativeChatLiveSessionArgs): Promise<void> {
    if (!root) {
      root = createRoot(document.createElement('div'))
    }
    await act(async () => root?.render(createElement(Probe, props)))
  }

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    latest = null
    liveSession.mockReset()
  })

  it('keeps settled messages during a same-identity rebind', async () => {
    liveSession.mockReturnValue(session('ready', [message('settled')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('loading', []))
    await render(ARGS)

    expect(latest?.readPhase).toBe('loading')
    expect(latest?.messages.map((entry) => entry.id)).toEqual(['settled'])
  })

  it('misses retained messages when the source owner changes', async () => {
    liveSession.mockReturnValue(session('ready', [message('owner-a')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('loading', []))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })

    expect(latest?.readPhase).toBe('loading')
    expect(latest?.messages).toEqual([])
  })

  it('keeps retained messages instead of a full-pane read error', async () => {
    liveSession.mockReturnValue(session('ready', [message('settled')]))
    await render(ARGS)

    liveSession.mockReturnValue({ ...session('error', []), status: 'error', error: 'read failed' })
    await render(ARGS)

    expect(latest?.messages.map((entry) => entry.id)).toEqual(['settled'])
    expect(latest?.readPhase).toBe('error')
    expect(latest?.status).toBe('ready')
    expect(latest?.error).toBeUndefined()
  })

  it('surfaces a read error when nothing was retained', async () => {
    liveSession.mockReturnValue({ ...session('error', []), status: 'error', error: 'read failed' })
    await render(ARGS)

    expect(latest?.messages).toEqual([])
    expect(latest?.status).toBe('error')
    expect(latest?.error).toBe('read failed')
  })

  it('does not overwrite retention with the session-less view', async () => {
    liveSession.mockReturnValue(session('ready', [message('settled')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('ready', [], null))
    await render({ ...ARGS, sessionId: null })
    liveSession.mockReturnValue(session('loading', []))
    await render(ARGS)

    expect(latest?.messages.map((entry) => entry.id)).toEqual(['settled'])
  })
})
