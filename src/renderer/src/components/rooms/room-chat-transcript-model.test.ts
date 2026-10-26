import { describe, expect, it } from 'vitest'
import { buildRoomChatSegments, selectRoomMemberChatLines } from './room-chat-transcript-model'
import type { RoomLine } from './room-types'

function line(seq: number, who: string, text: string, memberId?: string): RoomLine {
  return {
    seq,
    who,
    memberId: memberId ?? null,
    text,
    kind: null,
    createdAt: '2026-01-01T00:00:00Z'
  }
}

function directLine(seq: number, text: string, targetMemberId: string): RoomLine {
  return {
    seq,
    who: 'You',
    memberId: null,
    text,
    kind: null,
    targetMemberId,
    createdAt: '2026-01-01T00:00:00Z'
  }
}

describe('buildRoomChatSegments', () => {
  it('groups consecutive turns from one speaker', () => {
    const segments = buildRoomChatSegments([
      line(1, 'You', 'hello'),
      line(2, 'Chief', 'first', 'chief'),
      line(3, 'Chief', 'second', 'chief'),
      line(4, 'You', 'thanks')
    ])

    expect(segments.map((segment) => segment.entries.length)).toEqual([1, 2, 1])
    expect(segments[1].isUser).toBe(false)
    expect(segments[1].memberId).toBe('chief')
  })

  it('filters a member lens over the shared room log', () => {
    const lines = [
      line(1, 'You', 'room message'),
      line(3, 'Chief', 'other reply', 'chief'),
      line(4, 'Coder', 'direct reply', 'coder'),
      directLine(5, 'targeted user line', 'coder'),
      line(6, 'You', 'legacy @Coder message')
    ]
    expect(
      selectRoomMemberChatLines(lines, { memberId: 'coder', name: 'Coder' }).map(
        (line) => line.text
      )
    ).toEqual(['direct reply', 'targeted user line', 'legacy @Coder message'])
  })
})
