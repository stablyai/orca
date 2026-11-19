import { describe, expect, it } from 'vitest'
import type { BotGroup, BotGroupMessage } from './bot-group'
import { reduceBotGroupTranscript, type BotGroupTranscript } from './bot-group-transcript'

const group = (revision: number, sessions = ['s1', 's2']): BotGroup => ({
  id: 'g',
  name: 'Room',
  hostId: 'local',
  revision,
  folder: 'group-room',
  folderWorkspaceId: 'w',
  members: sessions.map((sessionId) => ({ botId: sessionId, sessionId })),
  replyMode: { kind: 'all' },
  createdAt: 0
})
const message = (sequence: number, text = `m${sequence}`): BotGroupMessage => ({
  id: `m${sequence}`,
  groupId: 'g',
  sequence,
  author: { kind: 'owner' },
  text,
  createdAt: sequence,
  turns: []
})
const page = (
  sequences: number[],
  options: { revision?: number; sessions?: string[]; hasEarlier?: boolean } = {}
): BotGroupTranscript => ({
  group: group(options.revision ?? 1, options.sessions),
  messages: sequences.map((sequence) => message(sequence)),
  hasEarlier: options.hasEarlier ?? false
})
const ids = (transcript: BotGroupTranscript | null) =>
  transcript?.messages.map((entry) => entry.sequence)

describe('room transcript', () => {
  const loaded = reduceBotGroupTranscript(
    reduceBotGroupTranscript(null, { kind: 'recent', page: page([3, 4], { hasEarlier: true }) }),
    { kind: 'earlier', page: page([1, 2]) }
  )

  it('drops history that no longer joins the new page, or after a member left', () => {
    expect(ids(reduceBotGroupTranscript(loaded, { kind: 'recent', page: page([7, 8]) }))).toEqual([
      7, 8
    ])
    expect(
      ids(
        reduceBotGroupTranscript(loaded, { kind: 'recent', page: page([4], { sessions: ['s1'] }) })
      )
    ).toEqual([4])
  })

  it('keeps history and upserts matching rows when a recent page changes reply mode', () => {
    expect(ids(loaded)).toEqual([1, 2, 3, 4])
    const sent = reduceBotGroupTranscript(loaded, { kind: 'sent', message: message(5) })
    const read = page([4, 5], { revision: 2, hasEarlier: true })
    const reread = reduceBotGroupTranscript(sent, {
      kind: 'recent',
      page: {
        ...read,
        group: { ...read.group, replyMode: { kind: 'mentions' } },
        messages: [message(4, 'edited'), message(5)]
      }
    })

    expect(ids(reread)).toEqual([1, 2, 3, 4, 5])
    expect(reread?.messages[3].text).toBe('edited')
    expect(reread?.group).toMatchObject({ revision: 2, replyMode: { kind: 'mentions' } })
    expect(reread?.hasEarlier).toBe(false)
  })

  it('a member change saved locally still voids old rows, and late pages cannot roll it back', () => {
    // Mirrors the review probe: group(rev 2, member removed), then an overlapping rev-2 read, then a delayed rev-1 read.
    const withTurn = (sequence: number, sessionId: string): BotGroupMessage => ({
      ...message(sequence),
      turns: [
        {
          botId: sessionId,
          botName: sessionId,
          avatar: null,
          agent: 'claude',
          sessionId,
          operationId: `op${sequence}`
        }
      ]
    })
    const before: BotGroupTranscript = {
      group: group(1),
      messages: [withTurn(1, 's2'), message(2)],
      hasEarlier: false
    }
    const saved = reduceBotGroupTranscript(before, {
      kind: 'group',
      group: group(2, ['s1'])
    })
    // The recent page overlaps on m2; m1 (the removed member's turn) is only in loaded history.
    const reread = reduceBotGroupTranscript(saved, {
      kind: 'recent',
      page: page([2], { revision: 2, sessions: ['s1'] })
    })
    const liveRemovedTurn = (transcript: BotGroupTranscript | null) =>
      transcript?.messages.some((entry) =>
        entry.turns.some((turn) => turn.sessionId === 's2' && !turn.revoked)
      )
    expect(liveRemovedTurn(reread)).toBe(false)
    expect(reread?.group.revision).toBe(2)
    const late = reduceBotGroupTranscript(reread, { kind: 'recent', page: page([1, 2]) })
    expect(late?.group.revision).toBe(2)
    expect(ids(late)).toEqual([2])
    expect(reduceBotGroupTranscript(reread, { kind: 'earlier', page: page([0]) })).toBe(reread)
  })
})
