import { describe, expect, it } from 'vitest'
import { pairToolBlocks, type NativeChatToolPair } from './native-chat-tool-pairs'
import type {
  NativeChatBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../native-chat-types'

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

function countedCalls(count: number): {
  calls: NativeChatToolCallBlock[]
  reads: () => number
} {
  let reads = 0
  const calls = Array.from({ length: count }, (_, index): NativeChatToolCallBlock => ({
    type: 'tool-call',
    name: 'Bash',
    input: {},
    get callId() {
      reads += 1
      return `call-${index}`
    }
  }))
  return { calls, reads: () => reads }
}

function countQueueMovement(blocks: readonly NativeChatBlock[]): {
  pairs: NativeChatToolPair[]
  movedSlots: number
} {
  const originalSplice = Array.prototype.splice
  const originalShift = Array.prototype.shift
  let movedSlots = 0
  Array.prototype.splice = function (
    this: unknown[],
    requestedIndex: number,
    deleteCount?: number,
    ...items: unknown[]
  ) {
    if (arguments.length === 0) {
      return originalSplice.call(this, 0, 0)
    }
    const requestedStart = Math.trunc(requestedIndex) || 0
    const start =
      requestedStart < 0
        ? Math.max(0, this.length + requestedStart)
        : Math.min(this.length, requestedStart)
    const removed =
      arguments.length < 2
        ? this.length - start
        : Math.min(this.length - start, Math.max(0, Math.trunc(deleteCount ?? 0) || 0))
    if (removed !== items.length) {
      movedSlots += this.length - start - removed
    }
    return originalSplice.call(this, requestedIndex, removed, ...items)
  }
  Array.prototype.shift = function (this: unknown[]) {
    movedSlots += Math.max(0, this.length - 1)
    return originalShift.call(this)
  }
  try {
    return { pairs: pairToolBlocks(blocks), movedSlots }
  } finally {
    Array.prototype.shift = originalShift
    Array.prototype.splice = originalSplice
  }
}

describe('tool pairing lookup budget', () => {
  it.each(['positional', 'named', 'duplicate'] as const)(
    'removes %s completions without quadratic queue movement',
    (kind) => {
      const count = 2048
      const idOf = (index: number): string | undefined =>
        kind === 'positional' ? undefined : kind === 'duplicate' ? 'same' : `call-${index}`
      const calls = Array.from({ length: count }, (_, index) => call(idOf(index)))
      const results = Array.from({ length: count }, (_, index) => result(idOf(index)))
      const blocks = [...calls, ...results]
      const measured = countQueueMovement(blocks)
      expectSameReferences(
        measured.pairs,
        calls.map((pending, index) => ({ call: pending, result: results[index] }))
      )
      expect(measured.movedSlots).toBeLessThanOrEqual(count * 3)
    }
  )

  it.each([64, 512, 2048])(
    'looks up named results in linear work for %i calls answered in reverse order',
    (count) => {
      const fixture = countedCalls(count)
      const results = Array.from({ length: count }, (_, index) => result(`call-${index}`))
      const pairs = pairToolBlocks([...fixture.calls, ...results.toReversed()])
      const lookupReads = fixture.reads()
      expect(pairs).toHaveLength(count)
      pairs.forEach((pair, index) => {
        expect(pair.call).toBe(fixture.calls[index])
        expect(pair.result).toBe(results[index])
      })
      expect(lookupReads).toBeLessThanOrEqual(count * 3)
    }
  )

  it.each([64, 512, 2048])(
    'keeps later named completions linear behind %i calls that emitted no result',
    (count) => {
      const fixture = countedCalls(count)
      const laterCalls = Array.from({ length: count }, (_, index) => call(`later-${index}`))
      const results = Array.from({ length: count }, (_, index) => result(`later-${index}`))
      const pairs = pairToolBlocks([
        ...fixture.calls,
        ...laterCalls.flatMap((laterCall, index) => [laterCall, results[index]!])
      ])
      const lookupReads = fixture.reads()
      expect(pairs).toHaveLength(count * 2)
      fixture.calls.forEach((pendingCall, index) => {
        expect(pairs[index]?.call).toBe(pendingCall)
        expect(pairs[index]?.result).toBeUndefined()
        expect(pairs[count + index]?.call).toBe(laterCalls[index])
        expect(pairs[count + index]?.result).toBe(results[index])
      })
      expect(lookupReads).toBeLessThanOrEqual(count * 3)
    }
  )

  it.each([64, 512, 2048])(
    'keeps unmatched named results linear behind %i pending calls',
    (count) => {
      const fixture = countedCalls(count)
      const results = Array.from({ length: count }, (_, index) => result(`missing-${index}`))
      const pairs = pairToolBlocks([...fixture.calls, ...results])
      const lookupReads = fixture.reads()
      expect(pairs).toHaveLength(count * 2)
      results.forEach((unmatched, index) => {
        expect(pairs[count + index]?.call).toBeUndefined()
        expect(pairs[count + index]?.result).toBe(unmatched)
      })
      expect(lookupReads).toBeLessThanOrEqual(count * 3)
    }
  )
})

describe('tool pairing identity and ordering', () => {
  it('indexes missing named answers only once when every pending call has no ID', () => {
    let reads = 0
    const count = 2048
    const calls: NativeChatToolCallBlock[] = Array.from({ length: count }, () => ({
      type: 'tool-call',
      name: 'Bash',
      input: {},
      get callId() {
        reads += 1
        return undefined
      }
    }))
    const results = Array.from({ length: count }, () => result('missing'))
    expect(pairToolBlocks([...calls, ...results])).toHaveLength(count * 2)
    expect(reads).toBeLessThanOrEqual(count * 3)
  })

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
