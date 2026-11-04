import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { deriveNativeChatStreamingText, nativeChatStreamingMessage } from '../native-chat-streaming'
import { orderNativeChatDisplayMessages } from './native-chat-message-order'
import { pendingSendsAsMessages, type NativeChatPendingSend } from './native-chat-pending-sends'

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

function tail(
  messages: NativeChatMessage[],
  pending: NativeChatPendingSend[],
  epoch: number | null
) {
  const echoes = pendingSendsAsMessages(pending, messages, epoch)
  return {
    messages: orderNativeChatDisplayMessages([...messages, preview, ...echoes]),
    preview: deriveNativeChatStreamingText({
      messages: [...messages, ...echoes],
      previewText: 'Starting the tests',
      working: true
    })
  }
}

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

  it('does not promote follow-ups when the active prompt lands, and suppresses the caught-up preview', () => {
    expect(tail([answer], [active, queued], 500).preview).toBe('Starting the tests')
    const landed: NativeChatMessage = {
      ...answer,
      id: 'prompt',
      transcriptOrder: 2,
      role: 'user',
      blocks: [{ type: 'text', text: active.text }]
    }
    const caughtUp: NativeChatMessage = {
      ...preview,
      id: 'answer',
      source: 'transcript',
      transcriptOrder: 3
    }
    const result = tail(
      [answer, landed, caughtUp],
      [active, queued, { ...queued, id: 'last', text: 'Then summarize', sentAt: 0 }],
      500
    )
    expect(result.messages.map((row) => row.id)).toEqual([
      'old-answer',
      'prompt',
      'answer',
      'streaming',
      'pending:follow-up',
      'pending:last'
    ])
    expect(result.preview).toBeNull()
  })

  it('makes a follow-up the active prompt when a later host epoch starts', () => {
    const result = tail([answer], [queued], 501)
    expect(result.messages.map((row) => row.id)).toEqual([
      'old-answer',
      'pending:follow-up',
      'streaming'
    ])
    expect(result.preview).toBe('Starting the tests')
  })

  it.each([
    [null, null],
    [500, null],
    [null, 500]
  ])('keeps queued placement without durable evidence of a new turn (%s → %s)', (sent, current) => {
    const result = tail([answer], [{ ...queued, queuedDuringWorkingEpoch: sent }], current)
    expect(result.messages.map((row) => row.id)).toEqual([
      'old-answer',
      'streaming',
      'pending:follow-up'
    ])
  })
})
