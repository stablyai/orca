import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { orderNativeChatDisplayMessages as orderNativeChatMessages } from '../../../../../../../shared/native-chat/transcript/native-chat-message-order'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../../../../shared/native-chat/native-chat-streaming'
import { sortForImageNormalization } from './native-chat-session-assembler'

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
  it('sorts the streaming preview after the prompt that caused it', () => {
    const normalized = sortForImageNormalization([
      msg({ id: 'pending:abc', role: 'user', timestamp: 20, source: 'scrape' }),
      msg({ id: NATIVE_CHAT_STREAMING_ID, timestamp: null }),
      msg({ id: 'real-user', role: 'user', timestamp: 10, transcriptOrder: 1 }),
      msg({ id: 'pending:first-queued', role: 'user', timestamp: 30, pendingSend: 'queued' }),
      msg({ id: 'pending:next-queued', role: 'user', timestamp: 2, pendingSend: 'queued' })
    ])
    const ordered = orderNativeChatMessages([...normalized])
    expect(ordered.map((m) => m.id)).toEqual([
      'real-user',
      'pending:abc',
      'streaming',
      'pending:first-queued',
      'pending:next-queued'
    ])
  })
})
