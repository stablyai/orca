import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { assignNativeChatPendingOccurrence } from './native-chat-pending-occurrence'
import {
  pendingSendsAsMessages,
  prunePendingSends,
  type NativeChatPendingSend
} from './native-chat-pending-sends'

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: number
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

describe('pending send occurrence reconciliation', () => {
  it('retires pathless queued images once each, preserving the next send across pruning', () => {
    const first = {
      id: 'image-1',
      text: '',
      imagePaths: ['/tmp/a.png'],
      sentAt: 100,
      afterMessageId: 'boundary'
    }
    const second = assignNativeChatPendingOccurrence([first], {
      id: 'image-2',
      text: '',
      imagePaths: ['/tmp/b.png'],
      sentAt: 130,
      afterMessageId: 'intermediate'
    })
    const older: NativeChatMessage[] = [
      {
        id: 'old-image',
        role: 'user',
        timestamp: 80,
        source: 'transcript',
        blocks: [{ type: 'image-ref', url: 'data:image/png;base64,AAAA' }]
      },
      message('boundary', 'assistant', 'working', 90),
      message('intermediate', 'assistant', 'still working', 120)
    ]
    expect(pendingSendsAsMessages([first, second], older).map((row) => row.id)).toEqual([
      'pending:image-1',
      'pending:image-2'
    ])
    const history: NativeChatMessage[] = [
      ...older,
      {
        id: 'queued-image',
        role: 'user',
        timestamp: 150,
        source: 'transcript',
        blocks: [{ type: 'image-ref', url: 'data:image/png;base64,AAAA' }]
      }
    ]

    expect(pendingSendsAsMessages([first, second], history).map((row) => row.id)).toEqual([
      'pending:image-2'
    ])
    const advanced = [...history, message('reply', 'assistant', 'received', 160)]
    const remaining = prunePendingSends([first, second], advanced)
    expect(remaining.map((entry) => entry.id)).toEqual(['image-2'])
    expect(pendingSendsAsMessages(remaining, advanced).map((row) => row.id)).toEqual([
      'pending:image-2'
    ])
    const completed: NativeChatMessage[] = [
      ...advanced,
      {
        id: 'queued-image-2',
        role: 'user',
        timestamp: 250,
        source: 'transcript',
        blocks: [{ type: 'image-ref', url: 'data:image/png;base64,BBBB' }]
      },
      message('reply-2', 'assistant', 'received again', 260)
    ]
    expect(prunePendingSends(remaining, completed)).toEqual([])
  })

  it('keeps uncertain image sends while retiring a later delivered image after cancellation or failure', () => {
    const first: NativeChatPendingSend = {
      id: 'image-1',
      text: '',
      imagePaths: ['/tmp/a.png'],
      sentAt: 100,
      afterMessageId: 'boundary'
    }
    const second = assignNativeChatPendingOccurrence([first], {
      id: 'image-2',
      text: '',
      imagePaths: ['/tmp/b.png'],
      sentAt: 110,
      afterMessageId: 'boundary'
    })
    const history: NativeChatMessage[] = [
      message('boundary', 'assistant', 'working', 90),
      {
        id: 'delivered-image',
        role: 'user',
        timestamp: 150,
        source: 'transcript',
        blocks: [{ type: 'image-ref', url: 'data:image/png;base64,AAAA' }]
      },
      message('reply', 'assistant', 'received', 160)
    ]

    const rejected = [{ ...first, delivery: 'rejected' as const }, second]
    expect(prunePendingSends(rejected, history).map((entry) => entry.id)).toEqual(['image-1'])
    expect(pendingSendsAsMessages(rejected, history).map((row) => row.id)).toEqual([
      'pending:image-1'
    ])
    expect(prunePendingSends([second], history)).toEqual([])
    expect(pendingSendsAsMessages([second], history)).toEqual([])

    const unconfirmed = [{ ...first, delivery: 'unconfirmed' as const }, second]
    expect(prunePendingSends(unconfirmed, history).map((entry) => entry.id)).toEqual(['image-1'])
    expect(pendingSendsAsMessages(unconfirmed, history).map((row) => row.id)).toEqual([
      'pending:image-1'
    ])
    const held = { ...first, writeUnconfirmedAt: 120 }
    expect(prunePendingSends([held, second], history).map((entry) => entry.id)).toEqual(['image-1'])
    expect(pendingSendsAsMessages([held], history).map((row) => row.id)).toEqual([
      'pending:image-1'
    ])
  })

  it('keeps the next identical echo after pruning an earlier occurrence', () => {
    const first = assignNativeChatPendingOccurrence<NativeChatPendingSend>([], {
      id: 'p1',
      text: 'repeat',
      sentAt: 100,
      afterMessageId: 'paged-out-boundary'
    })
    const repeated = [
      first,
      assignNativeChatPendingOccurrence([first], {
        id: 'p2',
        text: 'repeat',
        sentAt: 200,
        afterMessageId: 'paged-out-boundary'
      })
    ]
    expect(first.matchingOccurrence).toBeUndefined()
    expect(repeated[1]).toMatchObject({ matchingOccurrence: 2, matchingAfterTimestamp: 100 })

    const firstCompletedTurn = [
      message('u1', 'user', 'repeat', 150),
      message('a1', 'assistant', 'done', 160)
    ]
    const afterFirstPrune = prunePendingSends(repeated, firstCompletedTurn)

    expect(afterFirstPrune.map((entry) => entry.id)).toEqual(['p2'])
    expect(
      pendingSendsAsMessages(afterFirstPrune, firstCompletedTurn).map((entry) => entry.id)
    ).toEqual(['pending:p2'])

    const secondCompletedTurn = [
      ...firstCompletedTurn,
      message('u2', 'user', 'repeat', 250),
      message('a2', 'assistant', 'done again', 260)
    ]
    expect(pendingSendsAsMessages(afterFirstPrune, secondCompletedTurn)).toEqual([])
    expect(prunePendingSends(afterFirstPrune, secondCompletedTurn)).toEqual([])
  })
})

describe('pending sends typed through an agent TUI', () => {
  const COMPOSER_TEXT = 'summarize the failing test and propose a fix'

  it('prunes the echo of a row carrying the clear byte', () => {
    const pending = [{ id: 'p1', text: COMPOSER_TEXT, sentAt: 100, afterMessageId: 'boundary' }]
    const transcript = [
      message('u1', 'user', `\u0015${COMPOSER_TEXT}`, 150),
      message('a1', 'assistant', 'done', 160)
    ]

    expect(prunePendingSends(pending, transcript)).toEqual([])
    expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
  })
})
