// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import type {
  NativeChatLiveSession,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-contract'

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
  it.each(['loading', 'error'] as const)(
    'releases expanded fallback rows during %s',
    async (phase) => {
      const rows = Array.from({ length: 800 }, (_, index) => message(`row-${index}`))
      liveSession.mockReturnValue(session('ready', rows))
      await render(ARGS)
      const trimHistory = vi.fn()
      liveSession.mockReturnValue({ ...session(phase, []), trimHistory })
      await render(ARGS)
      expect(latest?.messages).toHaveLength(800)
      act(() => latest?.trimHistory?.())
      liveSession.mockReturnValue({ ...session(phase, []), trimHistory, olderHistoryGeneration: 1 })
      await render(ARGS)
      expect(latest?.messages).toHaveLength(300)
      expect(latest?.messages[0]?.id).toBe('row-500')
      expect(latest?.messages.at(-1)?.id).toBe('row-799')
      expect(trimHistory).toHaveBeenCalledOnce()
    }
  )
})
