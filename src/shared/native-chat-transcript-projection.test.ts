import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { projectNativeChatTranscript } from './native-chat-transcript-projection'

function message(
  id: string,
  timestamp: number,
  blocks: NativeChatMessage['blocks'],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage {
  return { id, timestamp, blocks, role, source: 'transcript' }
}

const prompt = message('prompt', 1, [{ type: 'text', text: 'Write a handoff' }], 'user')
const answer = message('answer', 2, [{ type: 'text', text: 'Here is the handoff' }])
// Shape recorded from a Claude Code transcript: the delivery is a user-role row.
const crossSession = message(
  'cross-session',
  3,
  [
    {
      type: 'text',
      text: 'Another Claude session sent a message: <cross-session-message from="uds:peer">May I swap the JAR?</cross-session-message>'
    }
  ],
  'user'
)
const reply = message('reply', 5, [{ type: 'text', text: 'No conflict, go ahead' }])

describe('projectNativeChatTranscript', () => {
  it('drops a delivery and marks the row after it as a new reply', () => {
    const { messages, replyStartIds } = projectNativeChatTranscript([
      prompt,
      answer,
      crossSession,
      reply
    ])
    expect(messages.map((m) => m.id)).toEqual(['prompt', 'answer', 'reply'])
    expect([...replyStartIds]).toEqual(['reply'])
  })

  it('keeps a reply boundary when the reply’s first tool run folds into the prior row', () => {
    const call = message('call', 4, [
      { type: 'tool-call', name: 'SendMessage', input: { to: 'peer' } }
    ])
    const { messages, replyStartIds } = projectNativeChatTranscript([
      prompt,
      answer,
      crossSession,
      call,
      reply
    ])
    // A delivery can land mid-turn, so tool pairing folds through it (see tool-fold).
    expect(messages.map((m) => m.id)).toEqual(['prompt', 'answer', 'reply'])
    expect([...replyStartIds]).toEqual(['reply'])
  })

  it('does not split a turn on reminders, which the agent does not answer', () => {
    const reminder = message(
      'reminder',
      3,
      [{ type: 'text', text: '<system-reminder>Todo list is empty</system-reminder>' }],
      'user'
    )
    const { messages, replyStartIds } = projectNativeChatTranscript([
      prompt,
      answer,
      reminder,
      reply
    ])
    expect(messages.map((m) => m.id)).toEqual(['prompt', 'answer', 'reply'])
    expect(replyStartIds.size).toBe(0)
  })
})
