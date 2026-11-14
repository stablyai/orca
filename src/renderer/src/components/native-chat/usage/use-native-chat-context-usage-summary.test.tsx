// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatContextUsageSummary } from './use-native-chat-context-usage-summary'
import { useNativeChatRetainedSession } from '../session/terminal/read/use-native-chat-retained-session'
import type { NativeChatLiveSession } from '../session/terminal/read/native-chat-live-session-contract'

const { liveSession } = vi.hoisted(() => ({ liveSession: vi.fn() }))
vi.mock('../session/terminal/read/use-native-chat-live-session', () => ({
  useNativeChatLiveSession: liveSession
}))

afterEach(() => {
  cleanup()
  liveSession.mockReset()
})

function session(inputTokens: number | null): NativeChatLiveSession {
  return {
    agent: 'claude',
    sessionId: 'session',
    status: inputTokens === null ? 'loading' : 'ready',
    readPhase: inputTokens === null ? 'loading' : 'ready',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    messages:
      inputTokens === null
        ? []
        : [
            {
              id: 'response',
              role: 'assistant',
              blocks: [],
              source: 'transcript',
              timestamp: 1,
              usage: {
                inputTokens,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                outputTokens: 100
              }
            }
          ]
  }
}

it('restores terminal context through view changes without carrying it into another conversation', () => {
  liveSession.mockReturnValue(session(63_296))
  const { result, rerender, unmount } = renderHook(
    ({ sessionId, enabled }) => {
      const transcript = useNativeChatRetainedSession({
        paneKey: 'tab:leaf',
        agent: 'claude',
        sessionId,
        enabled
      })
      return useNativeChatContextUsageSummary(undefined, {
        agent: 'claude',
        messages: transcript.messages,
        surface: null
      })
    },
    { initialProps: { sessionId: 'session-a', enabled: true } }
  )
  expect(result.current?.usedTokens).toBe(63_296)

  liveSession.mockReturnValue(session(null))
  rerender({ sessionId: 'session-a', enabled: false })
  rerender({ sessionId: 'session-a', enabled: true })
  expect(result.current?.usedTokens).toBe(63_296)

  rerender({ sessionId: 'session-b', enabled: true })
  expect(result.current).toBeNull()
  liveSession.mockReturnValue(session(12_000))
  rerender({ sessionId: 'session-b', enabled: true })
  expect(result.current?.usedTokens).toBe(12_000)

  unmount()
  const reopened = renderHook(() =>
    useNativeChatContextUsageSummary(undefined, {
      agent: 'claude',
      messages: session(12_000).messages,
      surface: null
    })
  )
  expect(reopened.result.current?.usedTokens).toBe(12_000)
})
