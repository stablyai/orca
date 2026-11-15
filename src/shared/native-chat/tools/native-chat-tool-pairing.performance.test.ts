import { describe, expect, it } from 'vitest'
import { pairToolBlocks, type NativeChatToolPair } from './native-chat-tool-pairs'
import type { NativeChatToolCallBlock, NativeChatToolResultBlock } from '../native-chat-types'

function call(callId?: string): NativeChatToolCallBlock {
  return { type: 'tool-call', name: 'Bash', input: {}, ...(callId !== undefined ? { callId } : {}) }
}

function result(callId?: string): NativeChatToolResultBlock {
  return { type: 'tool-result', output: 'done', ...(callId !== undefined ? { callId } : {}) }
}

function expectSameReferences(
  actual: readonly NativeChatToolPair[],
  expected: readonly NativeChatToolPair[]
): void {
  expect(actual).toEqual(expected)
  actual.forEach((pair, index) => {
    expect(pair.call).toBe(expected[index]?.call)
    expect(pair.result).toBe(expected[index]?.result)
  })
}

describe('tool pairing identity and ordering', () => {
  it('matches repeated and empty IDs FIFO while positional results consume the oldest call', () => {
    const calls = [call('same'), call(''), call('same'), call(), call('same')]
    const results = [result('same'), result(), result('same'), result(), result('same')]
    const blocks = Object.freeze([
      ...calls.map((block) => Object.freeze(block)),
      ...results.map((block) => Object.freeze(block))
    ])
    expectSameReferences(pairToolBlocks(blocks), [
      { call: calls[0], result: results[0] },
      { call: calls[1], result: results[1] },
      { call: calls[2], result: results[2] },
      { call: calls[3], result: results[3] },
      { call: calls[4], result: results[4] }
    ])
  })

  it('does not retroactively answer future calls or consume unrelated calls for a named result', () => {
    const early = result('later')
    const pending = call('waiting')
    const unrelated = result('other')
    const later = call('later')
    const completed = result('later')
    const positional = result()
    const repeated = result('later')
    expectSameReferences(
      pairToolBlocks([early, pending, unrelated, later, completed, positional, repeated]),
      [
        { result: early },
        { call: pending, result: positional },
        { result: unrelated },
        { call: later, result: completed },
        { result: repeated }
      ]
    )
  })
})
