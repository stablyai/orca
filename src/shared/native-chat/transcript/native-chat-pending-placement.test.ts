import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { nativeChatStreamingMessage } from '../native-chat-streaming'
import { orderNativeChatDisplayMessages } from './native-chat-message-order'
import {
  anchorNativeChatPendingSends,
  pendingSendsAsMessages,
  prunePendingSends,
  type NativeChatPendingSend
} from './native-chat-pending-sends'

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  order: number
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    source: 'transcript',
    timestamp: 100 + order,
    transcriptOrder: order
  }
}

const boundary = message('boundary', 'assistant', 'Ready', 1)
const testMessage = message('test-input', 'user', 'test', 2)
const reply = message('test-reply', 'assistant', 'Received', 3)
const preview = nativeChatStreamingMessage('Continuing')

function send(id: string, text: string): NativeChatPendingSend {
  return {
    id,
    text,
    sentAt: 1_000_000,
    afterMessageId: 'boundary',
    afterMessageTimestamp: 101,
    queuedDuringWorkingEpoch: null
  }
}

function display(history: NativeChatMessage[], pending: NativeChatPendingSend[]): string[] {
  return orderNativeChatDisplayMessages([
    ...history,
    preview,
    ...pendingSendsAsMessages(pending, history, null)
  ]).map((row) => row.id)
}

function reconcile(pending: NativeChatPendingSend[], history: NativeChatMessage[]) {
  return prunePendingSends(anchorNativeChatPendingSends(pending, history), history)
}

describe('pending sends overtaken by a later recorded send', () => {
  it('keeps two unmatched sends before the later input as its transcript grows', () => {
    const pending = [
      send('first', 'Where is the CLI?'),
      send('second', 'Still there?'),
      send('test', 'test')
    ]
    const history = [boundary, testMessage]

    expect(display([boundary], pending)).toEqual([
      'boundary',
      'streaming',
      'pending:first',
      'pending:second',
      'pending:test'
    ])
    expect(display(history, pending)).toEqual([
      'boundary',
      'pending:first',
      'pending:second',
      'test-input',
      'streaming'
    ])

    const retained = reconcile(pending, [...history, reply])
    expect(retained.map((entry) => entry.text)).toEqual(['Where is the CLI?', 'Still there?'])
    expect(
      display([...history, reply, message('later-reply', 'assistant', 'More work', 4)], retained)
    ).toEqual([
      'boundary',
      'pending:first',
      'pending:second',
      'test-input',
      'test-reply',
      'later-reply',
      'streaming'
    ])

    const caughtUp = [
      ...history,
      reply,
      message('first-input', 'user', 'Where is the CLI?', 5),
      message('first-reply', 'assistant', 'Here', 6)
    ]
    expect(prunePendingSends(retained, caughtUp).map((entry) => entry.text)).toEqual([
      'Still there?'
    ])
  })

  it('requires the correct occurrence before moving older sends ahead of a repeated input', () => {
    const pending = [
      send('first', 'Still there?'),
      send('test', 'test'),
      { ...send('repeat', 'test'), matchingOccurrence: 2 }
    ]
    const retained = reconcile(pending, [boundary, testMessage, reply])
    expect(display([boundary, testMessage, reply], retained)).toEqual([
      'boundary',
      'pending:first',
      'test-input',
      'test-reply',
      'streaming',
      'pending:repeat'
    ])
  })

  it('retains the recorded position when paging removes the later input', () => {
    const pending = [send('first', 'Still there?'), send('test', 'test')]
    const retained = reconcile(pending, [boundary, testMessage, reply])
    const laterHistory = [message('later-input', 'user', 'Continue', 4)]

    expect(display(laterHistory, retained)).toEqual(['pending:first', 'later-input', 'streaming'])
  })
})
