// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
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
    olderHistoryGeneration: 0,
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

  it('misses retained messages when the source owner changes', async () => {
    liveSession.mockReturnValue(session('ready', [message('owner-a')]))
    await render(ARGS)

    liveSession.mockReturnValue(session('loading', []))
    await render({ ...ARGS, runtimeEnvironmentId: 'owner-b' })

    expect(latest?.readPhase).toBe('loading')
    expect(latest?.messages).toEqual([])
  })
})
