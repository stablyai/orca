import { describe, expect, it } from 'vitest'

import { flattenRetainedSlice } from './flatten-retained-slice'

// Why 1 MB: comfortably above V8's SlicedString threshold, so a raw slice really does keep the
// parent alive and the difference between flattened and not is unmistakable in heapUsed.
const PARENT_CHARS = 1024 * 1024
const TAIL_CHARS = 512
const PARENTS = 8

function collect(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) {
    throw new Error('global.gc unavailable - config/vitest.config.ts must pass --expose-gc')
  }
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

// Distinct leading chars stop V8 sharing one backing store across the parents.
function makeParent(index: number, filler: string): string {
  return String.fromCharCode(0x41 + index) + filler.repeat(PARENT_CHARS - 1)
}

function retainedBytesForTails(filler: string, transform: (value: string) => string): number {
  const parents = Array.from({ length: PARENTS }, (_unused, index) => makeParent(index, filler))
  const baseline = collect()
  const tails = parents.map((parent) => transform(parent.slice(parent.length - TAIL_CHARS)))
  // Drop the parents; only the tails stay reachable.
  parents.length = 0
  const retained = collect() - baseline
  expect(tails).toHaveLength(PARENTS)
  expect(tails.every((tail) => tail.length === TAIL_CHARS)).toBe(true)
  return retained
}

describe('flattenRetainedSlice', () => {
  it('preserves content exactly', () => {
    expect(flattenRetainedSlice('')).toBe('')
    expect(flattenRetainedSlice('a')).toBe('a')
    const source = 'hello world, 漢字, [0m, \u{1f600}'
    expect(flattenRetainedSlice(source.slice(3))).toBe(source.slice(3))
  })

  it.each([
    ['one-byte', 'a'],
    ['two-byte', '漢']
  ])('drops the %s parent a raw slice would pin', (_label, filler) => {
    const raw = retainedBytesForTails(filler, (value) => value)
    const flattened = retainedBytesForTails(filler, flattenRetainedSlice)

    // A raw slice pins all 8 parents; flattening must keep only the tails.
    expect(raw).toBeGreaterThan(PARENTS * PARENT_CHARS * 0.5)
    expect(flattened).toBeLessThan(PARENTS * PARENT_CHARS * 0.05)
  })
})
