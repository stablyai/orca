// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'
import { clearPendingSendCacheForTests } from './native-chat-pending'

const boundary: NativeChatMessage = {
  id: 'boundary',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'before' }],
  timestamp: null,
  source: 'transcript'
}
const args = { paneKey: 'pane', agent: 'claude' as const }
function userRow(text: string): NativeChatMessage {
  return { ...boundary, id: `user:${text}`, role: 'user', blocks: [{ type: 'text', text }] }
}
function render() {
  return renderHook(
    ({ messages }) => useNativeChatPendingDelivery({ ...args, session: { messages } }),
    {
      initialProps: { messages: [boundary] }
    }
  )
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  clearPendingSendCacheForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('terminal Chat pending delivery', () => {
  it('records a send into a read empty transcript as after every row of that session', () => {
    const { result } = renderHook(() =>
      useNativeChatPendingDelivery({
        ...args,
        session: { messages: [], readPhase: 'ready', sessionId: 'session-1' }
      })
    )
    act(() => result.current.record('first'))
    expect(result.current.pending[0]).toMatchObject({
      afterMessageId: null,
      afterEmptyTranscriptSessionId: 'session-1'
    })
  })
  it('keeps a send, and its failure notice, when a different session with old history loads', () => {
    const old: NativeChatMessage[] = [
      { ...userRow('run tests'), id: 'old-user', timestamp: 10 },
      { ...boundary, id: 'old-answer', timestamp: 20 }
    ]
    const initialSession: Parameters<typeof useNativeChatPendingDelivery>[0]['session'] = {
      messages: [],
      readPhase: 'ready',
      sessionId: 'new-session'
    }
    const { result, rerender } = renderHook(
      ({ session }) => useNativeChatPendingDelivery({ ...args, session }),
      { initialProps: { session: initialSession } }
    )
    act(() => {
      result.current.reject(result.current.record('run tests'))
    })
    rerender({ session: { messages: old, readPhase: 'ready', sessionId: 'resumed-session' } })
    expect(result.current.pending.map((entry) => entry.text)).toEqual(['run tests'])
    expect(result.current.notices.size).toBe(1)
  })
  it('never flags an ordinary send, such as one Claude queues mid-turn', async () => {
    const { result } = render()
    act(() => result.current.record('queued follow up'))
    await tick(10 * 60_000)
    expect(result.current.notices.size).toBe(0)
    expect(result.current.pending[0]?.delivery).toBeUndefined()
  })
  it('keeps a failed send through Stop while dropping sends Stop may have cancelled', () => {
    const { result } = render()
    act(() => {
      result.current.reject(result.current.record('refused'))
      result.current.record('in flight')
    })
    act(() => result.current.clear())
    expect(result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
      ['refused', 'rejected']
    ])
  })
})
