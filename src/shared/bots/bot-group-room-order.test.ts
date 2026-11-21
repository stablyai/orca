import { describe, expect, it } from 'vitest'
import { botGroupRoomOrder } from './bot-group-room-order'

let sequence = 0
const post = (id: string) => ({ id, sequence: ++sequence })
const line = (id: string, root: string, rootSequence: number) => ({
  id,
  sequence: ++sequence,
  rootRequestId: root,
  rootSequence
})

describe('room order', () => {
  it('keeps every line that continues a post under that post, in stored order', () => {
    sequence = 0
    const lines = [
      post('a'),
      post('b'),
      line('b-mail', 'b', 2),
      line('a-handoff', 'a', 1),
      line('a-peer-mail', 'a', 1),
      line('a-paused', 'a', 1)
    ]
    expect(botGroupRoomOrder(lines).map(({ id }) => id)).toEqual([
      'a',
      'a-handoff',
      'a-peer-mail',
      'a-paused',
      'b',
      'b-mail'
    ])
  })

  it('leads the page with each earlier-page post’s lines together, oldest post first', () => {
    sequence = 10
    const lines = [
      line('y-1', 'y', 5),
      line('x-1', 'x', 3),
      post('c'),
      line('y-2', 'y', 5),
      line('x-2', 'x', 3)
    ]
    expect(botGroupRoomOrder(lines).map(({ id }) => id)).toEqual(['x-1', 'x-2', 'y-1', 'y-2', 'c'])
  })
})
