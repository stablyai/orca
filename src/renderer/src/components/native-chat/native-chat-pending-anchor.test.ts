import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { anchorPendingMessagesToSendBoundary } from './native-chat-pending-anchor'
import { pendingSendsAsMessages, type NativeChatPendingSend } from './native-chat-pending'

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
    expect(placed(laterTurns, pending)).toEqual(['u1', 'a1', 'pending:p1', 'a2', 'a3'])
  })

  it('leaves an echo still at the tail trailing, so the streaming bubble keeps its place', () => {
    const messages = [message('u1', 'user', 'first'), message('a1', 'assistant', 'working')]
    const anchored = anchorPendingMessagesToSendBoundary(
      messages,
      [send('p1', 'second', 'a1')],
      pendingSendsAsMessages([send('p1', 'second', 'a1')], messages)
    )
    expect(anchored.messages).toBe(messages)
    expect(anchored.trailing.map((entry) => entry.id)).toEqual(['pending:p1'])
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
    expect(placed(messages, pending)).toEqual(['a1', 'pending:p1', 'pending:p2', 'a2'])
  })

  it('returns the input untouched when there is nothing pending', () => {
    const messages = [message('u1', 'user', 'first')]
    const anchored = anchorPendingMessagesToSendBoundary(messages, [], [])
    expect(anchored.messages).toBe(messages)
    expect(anchored.trailing).toEqual([])
  })
})
