import { afterEach, expect, it } from 'vitest'
import { getPierreDiffCacheIdentity } from './pierre-diff-cache-identity'

afterEach(() => {
  for (let i = 0; i < 65; i += 1) {
    getPierreDiffCacheIdentity(`drain-${i}`, 'x', 'y')
  }
})

it('retains a single oversized identity so remounts reuse the worker cache key', () => {
  const original = 'o'.repeat(4_000_001)
  const first = getPierreDiffCacheIdentity('oversize', original, '')
  expect(getPierreDiffCacheIdentity('oversize', original, '')).toBe(first)
})

it('still evicts older identities once more than one entry exceeds the cap', () => {
  const a = 'a'.repeat(4_000_001)
  const b = 'b'.repeat(4_000_001)
  const firstA = getPierreDiffCacheIdentity('older-oversize', a, '')
  getPierreDiffCacheIdentity('newer-oversize', b, '')
  expect(getPierreDiffCacheIdentity('older-oversize', a, '')).not.toBe(firstA)
})
