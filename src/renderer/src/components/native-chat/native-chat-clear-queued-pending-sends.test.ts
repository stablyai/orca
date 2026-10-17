import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
import { clearQueuedOnPendingSends } from './native-chat-clear-queued-pending-sends'
import { pendingSendsAsMessages } from './native-chat-pending'
import { compareMessages } from './native-chat-session-assembler'

describe('clearQueuedOnPendingSends', () => {
  it('clears sticky queued so a follow-up sorts as an ordinary prompt above a later stream', () => {
    const pending = [
      { id: 'p1', text: 'trigger', sentAt: 10 },
      { id: 'p2', text: 'follow-up', sentAt: 20, queued: true as const }
    ]
    const cleared = clearQueuedOnPendingSends(pending)
    expect(cleared).toEqual([
      { id: 'p1', text: 'trigger', sentAt: 10 },
      { id: 'p2', text: 'follow-up', sentAt: 20 }
    ])
    expect(clearQueuedOnPendingSends(cleared)).toBe(cleared)

    const projected = pendingSendsAsMessages(cleared)
    const streaming = {
      id: NATIVE_CHAT_STREAMING_ID,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: '…' }],
      timestamp: null,
      source: 'hook' as const
    }
    expect([...projected, streaming].sort(compareMessages).map((message) => message.id)).toEqual([
      'pending:p1',
      'pending:p2',
      NATIVE_CHAT_STREAMING_ID
    ])
  })
})
