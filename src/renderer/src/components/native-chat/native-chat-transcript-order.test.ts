import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendNativeChatTranscriptOrder,
  createNativeChatTranscriptOrder,
  replaceNativeChatTranscriptOrder,
  settleNativeChatTranscriptOrder
} from './native-chat-transcript-order'

function message(id: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [], timestamp: 1, source: 'transcript' }
}

describe('native chat transcript order', () => {
  it('starts a generation with no sequenced rows', () => {
    const initial = createNativeChatTranscriptOrder(3)
    expect(initial).toMatchObject({ generation: 3, highWater: 0 })
    expect(initial.messageSequenceById.size).toBe(0)
  })

  it('sequences appends once and bounds retained ids to the live window', () => {
    const first = appendNativeChatTranscriptOrder(
      createNativeChatTranscriptOrder(3),
      [message('a'), message('b')],
      2
    )
    const next = appendNativeChatTranscriptOrder(first, [message('b'), message('c')], 2)

    expect(next.highWater).toBe(3)
    expect(next.messageSequenceById).toBe(first.messageSequenceById)
    expect([...next.messageSequenceById]).toEqual([
      ['b', 2],
      ['c', 3]
    ])
  })

  it('keeps append-order memory bounded to the retained transcript window', () => {
    let order = createNativeChatTranscriptOrder(3)
    for (let index = 0; index < 1_000; index += 1) {
      order = appendNativeChatTranscriptOrder(order, [message(`m-${index}`)], 8)
    }

    expect(order.highWater).toBe(1_000)
    expect(order.messageSequenceById.size).toBe(8)
  })

  it('resets ordering across a source rebind replace', () => {
    const appended = appendNativeChatTranscriptOrder(
      createNativeChatTranscriptOrder(3),
      [message('a')],
      1
    )

    expect(replaceNativeChatTranscriptOrder(appended)).toEqual({
      generation: 4,
      highWater: 0,
      messageSequenceById: new Map()
    })
  })

  it('settles first-seen authoritative rows without bumping generation', () => {
    const settled = settleNativeChatTranscriptOrder(
      createNativeChatTranscriptOrder(3),
      [message('u1'), message('a1')],
      8
    )

    expect(settled).toMatchObject({ generation: 3, highWater: 2 })
    expect([...settled.messageSequenceById]).toEqual([
      ['u1', 1],
      ['a1', 2]
    ])

    const again = settleNativeChatTranscriptOrder(
      settled,
      [message('u1'), message('a1'), message('u2')],
      8
    )
    expect(again).toMatchObject({ generation: 3, highWater: 3 })
    expect(again.messageSequenceById.get('u1')).toBe(1)
    expect(again.messageSequenceById.get('u2')).toBe(3)
  })

  it('bounds settled sequence memory to the retained window', () => {
    let order = createNativeChatTranscriptOrder(1)
    for (let index = 0; index < 20; index += 1) {
      order = settleNativeChatTranscriptOrder(
        order,
        Array.from({ length: index + 1 }, (_unused, n) => message(`m-${n}`)),
        4
      )
    }
    expect(order.messageSequenceById.size).toBe(4)
    // highWater is monotonic across re-sequenced window slides; only the map is bounded.
    expect(order.highWater).toBeGreaterThanOrEqual(20)
  })
})
