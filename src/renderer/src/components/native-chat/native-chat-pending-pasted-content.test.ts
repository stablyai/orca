import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { pendingSendsAsMessages, prunePendingSends } from './native-chat-pending'

const prompt = 'Summarize the failing tests.\n\nThen propose a fix for each one.'
const wrapped = `\n\n<pasted_content id="7e64">\n${prompt}\n</pasted_content id="7e64">\n`
function message(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id, role, source: 'transcript', timestamp: null, blocks: [{ type: 'text', text }] }
}

describe('pending echoes against Claude pasted-content rows', () => {
  // A new host delivers the decoded prompt; an old host still delivers the raw envelope.
  it.each([
    ['new host', prompt],
    ['old host', wrapped]
  ])('retires the echo with %s rows and keeps a second identical send', (_host, row) => {
    const history = [
      message('boundary', 'assistant', 'earlier'),
      message('user', 'user', row),
      message('reply', 'assistant', 'answer')
    ]
    const pending = [{ id: 'p1', text: prompt, sentAt: 999_000, afterMessageId: 'boundary' }]
    expect(pendingSendsAsMessages(pending, history)).toEqual([])
    expect(prunePendingSends(pending, history)).toEqual([])
    expect(
      prunePendingSends([...pending, { ...pending[0]!, id: 'p2', matchingOccurrence: 2 }], history)
    ).toHaveLength(1)
  })
})
