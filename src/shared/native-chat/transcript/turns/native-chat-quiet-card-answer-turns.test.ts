import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { nativeChatQuietCardAnswerRows } from './native-chat-quiet-card-answer-turns'

function row(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text }],
    ...extra
  }
}

describe('nativeChatQuietCardAnswerRows', () => {
  it('keeps a quiet card-answer turn that a person steered a message into', () => {
    const rows = [
      row('c1', 'user', 'Card google-setup/step answered: done', { orcaNotice: 'card-answer' }),
      row('s1', 'user', 'also check my calendar'),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    const hidden = nativeChatQuietCardAnswerRows(
      rows,
      ['c1', 'c1', 'c1'],
      new Set(['c1']),
      () => false
    )
    expect([...hidden]).toEqual([])
  })
})
