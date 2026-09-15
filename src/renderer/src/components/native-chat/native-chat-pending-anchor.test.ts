import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  anchorPendingMessagesToSendBoundary,
  nativeChatMessagesWithPending
} from './native-chat-pending-anchor'
import { pendingSendsAsMessages, type NativeChatPendingSend } from './native-chat-pending'
import { orderNativeChatMessages } from './native-chat-message-grouping'

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp = 1
): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function send(id: string, text: string, afterMessageId: string | null): NativeChatPendingSend {
  return { id, text, sentAt: 100, afterMessageId }
}

function placed(
  messages: readonly NativeChatMessage[],
  pending: readonly NativeChatPendingSend[]
): string[] {
  const anchored = anchorPendingMessagesToSendBoundary(
    messages,
    pending,
    pendingSendsAsMessages([...pending], [...messages])
  )
  return [...anchored.messages, ...anchored.trailing].map((entry) => entry.id)
}

// A mid-turn send is absorbed into the running turn: Claude Code writes
// `queue-operation` (`reason: absorbed_mid_turn`) and a `queued_command`
// attachment, never a `type:"user"` row, so the echo has nothing to match.
describe('anchorPendingMessagesToSendBoundary', () => {
  it('keeps an unmatchable echo where it was sent as the turn keeps going', () => {
    const atSendTime = [message('u1', 'user', 'first'), message('a1', 'assistant', 'working')]
    const pending = [send('p1', 'second', 'a1')]
    expect(placed(atSendTime, pending)).toEqual(['u1', 'a1', 'pending-at:p1'])

    const laterTurns = [
      ...atSendTime,
      message('a2', 'assistant', 'still working', 2),
      message('a3', 'assistant', 'done', 3)
    ]
    expect(placed(laterTurns, pending)).toEqual(['u1', 'a1', 'pending-at:p1', 'a2', 'a3'])
  })

  // The case the first attempt at this fix missed: `foldToolMessages` folds a
  // whole turn into the assistant message that opened it, so that message keeps
  // its id and grows in place. A mid-turn send therefore names a boundary that is
  // STILL the tail once the reply is complete — treating "at the tail" as "nothing
  // came after" left the echo below the entire answer, exactly the reported bug.
  it('anchors even when the boundary is still the tail, because a folded turn grows in place', () => {
    const atSendTime = [message('u1', 'user', 'first'), message('a1', 'assistant', 'working')]
    const pending = [send('p1', 'second', 'a1')]
    const grownInPlace = [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'working, ran 3 commands, done')
    ]
    expect(placed(atSendTime, pending)).toEqual(['u1', 'a1', 'pending-at:p1'])
    expect(placed(grownInPlace, pending)).toEqual(['u1', 'a1', 'pending-at:p1'])
  })

  it('trails an echo whose boundary a bounded read paged out instead of guessing', () => {
    const messages = [message('a2', 'assistant', 'later'), message('a3', 'assistant', 'latest', 3)]
    expect(placed(messages, [send('p1', 'second', 'gone')])).toEqual(['a2', 'a3', 'pending:p1'])
  })

  it('trails an echo that recorded no boundary', () => {
    const messages = [message('u1', 'user', 'first'), message('a1', 'assistant', 'working', 2)]
    expect(placed(messages, [send('p1', 'second', null)])).toEqual(['u1', 'a1', 'pending:p1'])
  })

  it('keeps send order among echoes sharing one boundary', () => {
    const messages = [message('a1', 'assistant', 'working'), message('a2', 'assistant', 'done', 2)]
    const pending = [send('p1', 'second', 'a1'), send('p2', 'third', 'a1')]
    expect(placed(messages, pending)).toEqual(['a1', 'pending-at:p1', 'pending-at:p2', 'a2'])
  })

  it('returns the input untouched when there is nothing pending', () => {
    const messages = [message('u1', 'user', 'first')]
    const anchored = anchorPendingMessagesToSendBoundary(messages, [], [])
    expect(anchored.messages).toBe(messages)
    expect(anchored.trailing).toEqual([])
  })
})

describe('nativeChatMessagesWithPending', () => {
  it('places an anchored echo before markers and streaming, and a trailing one after', () => {
    const messages = [
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'working'),
      message('a2', 'assistant', 'done', 2)
    ]
    const pending = [send('p1', 'sent mid-turn', 'a1'), send('p2', 'boundary paged out', 'gone')]
    const combined = nativeChatMessagesWithPending(
      messages,
      pending,
      pendingSendsAsMessages(pending, messages),
      [message('marker', 'assistant', '/clear')],
      [message('streaming', 'assistant', 'typing', 3)]
    )
    expect(combined.map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
      'pending-at:p1',
      'a2',
      'marker',
      'streaming',
      'pending:p2'
    ])
  })
})

// Review note from @pullfrog on #20847: the anchored array never reaches the
// DOM, because `NativeChatMessageList` re-sorts it through
// `orderNativeChatMessages`, whose `messageSortRank` pins every `pending:*` row
// to rank 2 — the tail. Asserting the array alone therefore proves nothing.
describe('anchored order survives the list projection', () => {
  it('keeps the anchored echo in place after orderNativeChatMessages', () => {
    const messages = [
      message('u1', 'user', 'first', 10),
      message('a1', 'assistant', 'opened the turn', 20),
      message('a2', 'assistant', 'kept working', 30),
      message('a3', 'assistant', 'finished', 40)
    ]
    const pending = [send('p1', 'sent mid-turn', 'a1')]
    const anchoredThenSorted = orderNativeChatMessages([
      ...anchorPendingMessagesToSendBoundary(
        messages,
        pending,
        pendingSendsAsMessages(pending, messages)
      ).messages
    ])
    expect(anchoredThenSorted.map((entry) => entry.id)).toEqual([
      'u1',
      'a1',
      'pending-at:p1',
      'a2',
      'a3'
    ])
  })
})
