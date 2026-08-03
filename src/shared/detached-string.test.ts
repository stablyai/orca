import { describe, expect, it } from 'vitest'
import { detachString } from './detached-string'
import { forceGc } from './string-retention-measurement'

describe('detachString', () => {
  it('returns the value unchanged', () => {
    for (const value of ['', 'a', '✳ Working… (esc to interrupt)', '{"questions":[]}', ' \n\t ']) {
      expect(detachString(value)).toBe(value)
    }
  })

  it('preserves surrogate pairs and astral characters', () => {
    const value = '🚀 done \u{1f4a9}'
    expect(detachString(value)).toBe(value)
    expect(detachString(value).length).toBe(value.length)
  })

  it('preserves a lone surrogate', () => {
    const value = '\ud83d'
    expect(detachString(value)).toBe(value)
  })

  // A ≥13-char raw control arm proves both SlicedString retention and default-run GC.
  it('detaches a slice from its parent buffer', () => {
    const chunkChars = 16 * 1024
    const slices = 4096
    const measure = (detach: boolean): number => {
      const held: string[] = []
      forceGc()
      const before = process.memoryUsage().heapUsed
      for (let index = 0; index < slices; index += 1) {
        const sliced = `${'x'.repeat(chunkChars)}|retained-title-${index}`.slice(chunkChars + 1)
        held.push(detach ? detachString(sliced) : sliced)
      }
      forceGc()
      const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)
      expect(held).toHaveLength(slices)
      expect(held[0].length).toBeGreaterThanOrEqual(13)
      return retainedMiB
    }

    const attachedMiB = measure(false)
    const detachedMiB = measure(true)
    expect(attachedMiB).toBeGreaterThan(16)
    expect(detachedMiB).toBeLessThan(attachedMiB / 8)
  })

  // Backs the comment in detached-string.ts: these read like harmless simplifications of
  // the concat idiom, but none of them flatten, so each still pins the parent chunk.
  it.each([
    ['slice(0)', (value: string): string => value.slice(0)],
    ['String(value)', (value: string): string => String(value)],
    ['repeat(1)', (value: string): string => value.repeat(1)]
  ])('does not detach via %s', (_name, simplify) => {
    const chunkChars = 16 * 1024
    const slices = 512
    const held: string[] = []
    forceGc()
    const before = process.memoryUsage().heapUsed
    for (let index = 0; index < slices; index += 1) {
      held.push(simplify(`${'x'.repeat(chunkChars)}|retained-title-${index}`.slice(chunkChars + 1)))
    }
    forceGc()
    const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    expect(held[0].length).toBeGreaterThanOrEqual(13)
    expect(retainedMiB).toBeGreaterThan(((chunkChars * slices) / (1024 * 1024)) * 0.75)
  })

  // Pins the V8_ROPE_MIN_LENGTH short-circuit: a V8 change must fail here, not leak silently.
  it('pins the 13-char slice boundary V8 uses to start retaining parents', () => {
    const chunkChars = 16 * 1024
    const slices = 512
    const measure = (tailChars: number): number => {
      const held: string[] = []
      forceGc()
      const before = process.memoryUsage().heapUsed
      for (let index = 0; index < slices; index += 1) {
        const source = `${'x'.repeat(chunkChars)}${String(index).padStart(tailChars, 'y')}`
        held.push(source.slice(chunkChars))
      }
      forceGc()
      const retainedMiB = (process.memoryUsage().heapUsed - before) / (1024 * 1024)
      expect(held).toHaveLength(slices)
      expect(held[0]).toHaveLength(tailChars)
      return retainedMiB
    }

    const pinnedMiB = (chunkChars * slices) / (1024 * 1024)
    expect(measure(12)).toBeLessThan(pinnedMiB / 8)
    expect(measure(13)).toBeGreaterThan(pinnedMiB * 0.75)
  })
})
