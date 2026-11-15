import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { nativeChatStreamingMessage } from '../../native-chat-streaming'
import { orderNativeChatDisplayMessages } from './native-chat-message-order'
import {
  pendingSendsAsMessages,
  type NativeChatPendingSend
} from '../pending-sends/native-chat-pending-sends'

const answer: NativeChatMessage = {
  id: 'old-answer',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Earlier answer that is longer than the new reply' }],
  timestamp: 9_000_000,
  source: 'transcript',
  transcriptOrder: 1
}
const active: NativeChatPendingSend = {
  id: 'active',
  text: 'Run the tests',
  sentAt: 10,
  afterMessageId: answer.id
}
const queued: NativeChatPendingSend = {
  id: 'follow-up',
  text: 'Then update the docs',
  sentAt: 1,
  afterMessageId: answer.id,
  queuedDuringWorkingEpoch: 500
}
const preview = nativeChatStreamingMessage('Starting the tests')

describe('terminal chat causal order', () => {
  it('keeps idle sends and launch prompts before their answer and queued sends after it despite clock skew', () => {
    const echoes = pendingSendsAsMessages([active, queued], [answer], 500)
    const rows = orderNativeChatDisplayMessages([
      answer,
      preview,
      ...echoes,
      { ...answer, id: 'launch-pending:tab', role: 'user', timestamp: 99_000_000 },
      { ...answer, id: 'host-queue', role: 'user', queued: true }
    ])
    expect(rows.map((row) => row.id)).toEqual([
      'old-answer',
      'pending:active',
      'launch-pending:tab',
      'streaming',
      'pending:follow-up',
      'host-queue'
    ])
  })
})
