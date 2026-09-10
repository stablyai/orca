import { describe, expect, it } from 'vitest'
import { pairToolBlocks, type NativeChatToolPair } from './native-chat-tool-fold'
import type { NativeChatBlock } from './native-chat-types'

function original(blocks: readonly NativeChatBlock[], limit: number): NativeChatToolPair[] {
  const pairs: NativeChatToolPair[] = []
  const slots: (number | null)[] = []
  let ordinal = 0
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      if (pairs.length < limit) {
        slots.push(pairs.length)
        pairs.push({ call: block })
      } else {
        slots.push(null)
      }
    } else if (block.type === 'tool-result') {
      const slot = slots[ordinal]
      if (slot === undefined) {
        if (pairs.length < limit) {
          pairs.push({ result: block })
        }
      } else {
        ordinal++
        if (slot !== null) {
          pairs[slot].result = block
        }
      }
    }
  }
  return pairs
}

const call: NativeChatBlock = { type: 'tool-call', name: 'read', input: {} }
const result: NativeChatBlock = { type: 'tool-result', output: 'done' }

describe('tool pair limits', () => {
  it('stops visiting blocks once retained pairs are fully answered', () => {
    let reads = 0
    const tail = Array.from({ length: 10000 }, () => ({
      get type() {
        reads++
        return 'tool-call' as const
      },
      name: 'read',
      input: {}
    }))
    expect(pairToolBlocks([call, result, ...tail], 1)).toEqual([{ call, result }])
    expect(reads).toBe(0)
  })

  it('preserves FIFO and stray-result behavior across finite and unlimited limits', () => {
    for (let seed = 0; seed < 128; seed++) {
      const blocks = Array.from({ length: 30 }, (_, i) =>
        (seed * 13 + i * 17) % 7 < 3
          ? call
          : (seed + i) % 3
            ? result
            : { type: 'text' as const, text: 'hi' }
      )
      for (const limit of [0, 1, 2, 5, 0.5, -1, Infinity, Number.NaN]) {
        expect(pairToolBlocks(blocks, limit)).toEqual(original(blocks, limit))
      }
    }
    expect(pairToolBlocks([call, call, result, result], 1)).toEqual(
      original([call, call, result, result], 1)
    )
  })
  it('still answers every retained call when the results trail far behind', () => {
    // The break must not fire while a retained call is unanswered, or the mobile run
    // would render a spinner for a tool that actually completed.
    const blocks = [call, call, ...Array.from({ length: 5000 }, () => result)]
    expect(pairToolBlocks(blocks, 2)).toEqual([
      { call, result },
      { call, result }
    ])
    expect(pairToolBlocks(blocks, 2)).toEqual(original(blocks, 2))
  })

  it('keeps a leading stray result and then stops at the limit', () => {
    const blocks = [result, call, result, call, result]
    expect(pairToolBlocks(blocks, 1)).toEqual(original(blocks, 1))
    expect(pairToolBlocks(blocks, 1)).toEqual([{ result }])
  })
})
