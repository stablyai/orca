import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  anchorPendingMessagesToSendBoundary,
  nativeChatMessagesWithPending
} from './native-chat-pending-anchor'
import { pendingSendsAsMessages, type NativeChatPendingSend } from './native-chat-pending'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'

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
    expect(placed(atSendTime, pending)).toEqual(['u1', 'a1', 'pending:p1'])

    const laterTurns = [
      ...atSendTime,
      message('a2', 'assistant', 'still working', 2),
      message('a3', 'assistant', 'done', 3)
    ]
    expect(placed(laterTurns, pending)).toEqual(['u1', 'a1', 'pending-at:p1', 'a2', 'a3'])
  })

  // Review note from @pullfrog: a still-at-tail echo must stay on `pending:` and
  // rank 2, or it sorts AHEAD of the streaming preview — the tier the comment on
  // `messageSortRank` calls load-bearing. Only an echo the transcript moved past
  // is repositioned.
  it('leaves a still-at-tail echo trailing so the streaming bubble keeps its place', () => {
    const atSendTime = [message('u1', 'user', 'first', 10), message('a1', 'assistant', 'go', 20)]
    const pending = [send('p1', 'second', 'a1')]
    expect(placed(atSendTime, pending)).toEqual(['u1', 'a1', 'pending:p1'])

    const turnMovedOn = [...atSendTime, message('a2', 'assistant', 'done', 30)]
    expect(placed(turnMovedOn, pending)).toEqual(['u1', 'a1', 'pending-at:p1', 'a2'])
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

// Two regressions @pullfrog caught in the anchoring itself, both verified through
// the same path the list renders.
describe('anchoring does not cost the turn its content or its tiers', () => {
  it('keeps a tool result whose call sits after the echo', () => {
    const messages: NativeChatMessage[] = [
      message('u1', 'user', 'first', 10),
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 20,
        source: 'transcript',
        blocks: [
          { type: 'text', text: 'opened the turn' },
          { type: 'tool-call', name: 'Bash', input: { command: 'ls' } }
        ]
      },
      {
        id: 'tr',
        role: 'tool',
        timestamp: 40,
        source: 'transcript',
        blocks: [{ type: 'tool-result', output: 'a.txt' }]
      }
    ]
    const pending = [send('p1', 'sent mid-turn', 'a1')]
    const project = createNativeChatMessageListProjection()
    const rows = project([
      ...anchorPendingMessagesToSendBoundary(
        messages,
        pending,
        pendingSendsAsMessages(pending, messages)
      ).messages
    ])
    // Ending the fold run on the echo strands the result, and
    // `dropUnattributableToolResults` then deletes the row outright.
    const outputs = rows.flatMap((row) =>
      row.blocks.filter((block) => block.type === 'tool-result').map((block) => block.output)
    )
    expect(outputs).toEqual(['a.txt'])
    expect(rows.map((row) => row.id)).toContain('pending-at:p1')
  })

  it('keeps a still-at-tail echo behind the streaming preview', () => {
    const messages = [message('u1', 'user', 'first', 10), message('a1', 'assistant', 'go', 20)]
    const pending = [send('p1', 'just sent', 'a1')]
    const streaming: NativeChatMessage = {
      id: NATIVE_CHAT_STREAMING_ID,
      role: 'assistant',
      timestamp: null,
      source: 'scrape',
      blocks: [{ type: 'text', text: 'typing' }]
    }
    const anchored = anchorPendingMessagesToSendBoundary(
      messages,
      pending,
      pendingSendsAsMessages(pending, messages)
    )
    const ordered = orderNativeChatMessages([...anchored.messages, streaming, ...anchored.trailing])
    expect(ordered.map((row) => row.id)).toEqual([
      'u1',
      'a1',
      NATIVE_CHAT_STREAMING_ID,
      'pending:p1'
    ])
  })
})
