import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat/native-chat-streaming'

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
  it('sorts the streaming preview after real content but before optimistic echoes', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'pending:abc', role: 'user', timestamp: 20, source: 'scrape' }),
      msg({ id: NATIVE_CHAT_STREAMING_ID, timestamp: null }),
      msg({ id: 'real-user', role: 'user', timestamp: 10 })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['real-user', 'streaming', 'pending:abc'])
  })
})
