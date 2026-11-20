import { describe, expect, it } from 'vitest'
import { botGroupRoomOrder } from './bot-group-room-order'

const post = (id: string) => ({ id, author: { kind: 'owner' as const } })
const bot = { kind: 'bot' as const, id: 'scout', name: 'Scout' }
const handoff = (id: string, root: string) => ({
  id,
  author: bot,
  rootRequestId: root,
  mentioned: true as const
})

describe('room order', () => {
  it("puts a late hand-off and paused line under the post they continue, before the next person's post", () => {
    const lines = [
      post('a'),
      post('b'),
      { id: 'mail', author: bot, rootRequestId: 'b' },
      handoff('h1', 'a'),
      { id: 'paused', author: bot, rootRequestId: 'a', pausedAfter: 6 },
      handoff('h2', 'b')
    ]
    expect(botGroupRoomOrder(lines).map((line) => line.id)).toEqual([
      'a',
      'h1',
      'paused',
      'b',
      'mail',
      'h2'
    ])
  })

  it('leads the page with a hand-off whose post is on an earlier page', () => {
    const lines = [
      { id: 'mail', author: bot, rootRequestId: 'old' },
      post('c'),
      handoff('h', 'old')
    ]
    expect(botGroupRoomOrder(lines).map((line) => line.id)).toEqual(['mail', 'h', 'c'])
  })
})
