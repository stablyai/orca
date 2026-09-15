import { expect, it, vi } from 'vitest'
import { HermesSessionRunIndex } from './hermes-session-run-index'

const time = (key: string | null): number =>
  key === null || key === 'invalid' ? Number.NaN : Number(key)

function legacyMatch(
  keys: (string | null)[],
  used: Set<number>,
  key: string | null
): number | null {
  const exact = keys.findIndex((candidate, index) => !used.has(index) && candidate === key)
  if (exact !== -1) {
    return exact
  }
  const outputTime = time(key)
  if (!Number.isFinite(outputTime)) {
    return null
  }
  let best: number | null = null
  let bestGap = Infinity
  keys.forEach((candidate, index) => {
    const gap = outputTime - time(candidate)
    if (!used.has(index) && Number.isFinite(gap) && gap >= 0 && gap <= 24 && gap < bestGap) {
      best = index
      bestGap = gap
    }
  })
  return best
}

it('preserves exact, null, invalid, duplicate-time, source-order, and maximum-gap matching', () => {
  let seed = 70291
  const random = (max: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  const pool = [null, 'invalid', '-1', '0', '00', '1', '2', '24', '25', '26', '50']
  for (let trial = 0; trial < 500; trial++) {
    const keys = Array.from({ length: random(60) }, () => pool[random(pool.length)])
    const index = new HermesSessionRunIndex(keys, time, 24)
    const used = new Set<number>()
    for (let query = 0; query < 80; query++) {
      const key = pool[random(pool.length)]
      const expected = legacyMatch(keys, used, key)
      expect(index.find(key)).toBe(expected)
      // Invalid source rows can decline a match; find must leave it available.
      if (expected !== null && random(4) !== 0) {
        used.add(expected)
        index.use(expected)
      }
    }
    expect(index.used).toEqual(used)
  }
})

it('parses each session timestamp once across a long run history', () => {
  const parse = vi.fn(time)
  const count = 5000
  const index = new HermesSessionRunIndex(
    Array.from({ length: count }, (_, i) => String(i * 60)),
    parse,
    24
  )
  for (let i = count - 1; i >= 0; i--) {
    const match = index.find(String(i * 60 + 2))
    expect(match).toBe(i)
    index.use(match!)
  }
  expect(parse).toHaveBeenCalledTimes(count * 2)
  expect(index.find('9999999')).toBeNull()
})
