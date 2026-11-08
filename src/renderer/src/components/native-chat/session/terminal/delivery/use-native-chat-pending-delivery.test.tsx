// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
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
beforeEach(() => {
  vi.useFakeTimers()
  clearPendingSendCacheForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('terminal Chat pending delivery', () => {
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
