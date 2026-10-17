import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'

function msg(
  overrides: Partial<NativeChatMessage> & Pick<NativeChatMessage, 'id'>
): NativeChatMessage {
  return {
    role: 'assistant',
    blocks: [],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

describe('orderNativeChatMessages', () => {
  it('orders by ascending timestamp, null first', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'b', timestamp: 20 }),
      msg({ id: 'a', timestamp: 10 }),
      msg({ id: 'n', timestamp: null })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['n', 'a', 'b'])
  })

  it('breaks timestamp ties by id deterministically', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'z', timestamp: 5 }),
      msg({ id: 'a', timestamp: 5 })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['a', 'z'])
  })

  it('sorts a pending user prompt before an active streaming assistant preview triggered by it', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'pending:abc', role: 'user', timestamp: 20, source: 'scrape' }),
      msg({ id: NATIVE_CHAT_STREAMING_ID, timestamp: null }),
      msg({ id: 'real-user', role: 'user', timestamp: 10 })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['real-user', 'pending:abc', 'streaming'])
  })

  it('sorts a pending user prompt before a subsequent assistant response', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'resp-1', role: 'assistant', timestamp: 200 }),
      msg({ id: 'pending:abc', role: 'user', timestamp: 100, source: 'scrape' })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['pending:abc', 'resp-1'])
  })

  it('sorts a queued prompt after an active streaming assistant preview', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'pending:queued', role: 'user', timestamp: 30, source: 'scrape', queued: true }),
      msg({ id: NATIVE_CHAT_STREAMING_ID, timestamp: null }),
      msg({ id: 'pending:trigger', role: 'user', timestamp: 20, source: 'scrape' })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['pending:trigger', 'streaming', 'pending:queued'])
  })
})
