import { describe, expect, it } from 'vitest'

import { detachString } from './detached-string'

describe('detachString', () => {
  it('returns code-unit-identical strings', () => {
    for (const value of [
      '',
      'a',
      'plain title',
      '⠋ Claude working',
      '😀 done',
      'x'.repeat(10_000)
    ]) {
      expect(detachString(value)).toBe(value)
    }
  })

  it('preserves lone surrogates and unpaired astral halves', () => {
    expect(detachString('\uD800')).toBe('\uD800')
    expect(detachString('\uDC00\uD800')).toBe('\uDC00\uD800')
    expect(detachString('A\uD800B\uDC00😀')).toBe('A\uD800B\uDC00😀')
  })

  it('handles values far past the argument-spread limit', () => {
    const huge = 'z'.repeat(500_000)
    expect(detachString(huge)).toBe(huge)
  })

  it('releases the source string it was copied from', () => {
    // Why: this is the OOM. A sliced substring keeps its parent alive, so a
    // 20-char title pins the whole multi-megabyte PTY chunk it came from.
    const gc = (globalThis as { gc?: () => void }).gc
    if (!gc) {
      return
    }
    const megabytes = 8
    // Why a nested frame: the source of the final iteration stays reachable from
    // the building frame's stack slots, which would bill one chunk to the
    // detached case regardless of correctness. Let that frame exit before we GC.
    const build = (make: (source: string) => string, kept: string[]): void => {
      for (let i = 0; i < 16; i += 1) {
        const source = `${'x'.repeat(megabytes * 1024 * 1024)}retained-title-${i}`
        kept.push(make(source))
      }
    }
    const sample = (make: (source: string) => string): number => {
      for (let i = 0; i < 4; i += 1) {
        gc()
      }
      const before = process.memoryUsage().heapUsed
      const kept: string[] = []
      build(make, kept)
      for (let i = 0; i < 4; i += 1) {
        gc()
      }
      const retainedBytes = process.memoryUsage().heapUsed - before
      expect(kept).toHaveLength(16)
      return retainedBytes / (1024 * 1024)
    }

    const sliced = sample((source) => source.slice(source.lastIndexOf('retained-title-')))
    const detached = sample((source) =>
      detachString(source.slice(source.lastIndexOf('retained-title-')))
    )
    // Why: the over-cap title path detaches a prefix+suffix concatenation, which
    // is a rope over two slices rather than a single slice.
    const detachedRope = sample((source) =>
      detachString(`${source.slice(0, 8)}${source.slice(source.lastIndexOf('retained-title-'))}`)
    )

    expect(sliced).toBeGreaterThan(16 * megabytes * 0.5)
    expect(detached).toBeLessThan(1)
    expect(detachedRope).toBeLessThan(1)
  })
})
