import { describe, expect, it } from 'vitest'
import {
  nextSshTargetGeneration,
  resolveSshTargetGenerationHighWaterMark,
  sanitizeSshTargetGeneration
} from './ssh-target-generation'

describe('sanitizeSshTargetGeneration', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined, {}])(
    'rejects %p',
    (value) => {
      expect(sanitizeSshTargetGeneration(value)).toBeUndefined()
    }
  )

  it('accepts issued generations', () => {
    expect(sanitizeSshTargetGeneration(1)).toBe(1)
    expect(sanitizeSshTargetGeneration(42)).toBe(42)
  })
})

describe('resolveSshTargetGenerationHighWaterMark', () => {
  it('never reissues a generation an automation already captured', () => {
    // The counter rolled back to 2, but an automation is fenced on 9.
    const highWaterMark = resolveSshTargetGenerationHighWaterMark({
      persistedCounter: 2,
      targetGenerations: [1, 2],
      capturedGenerations: [9]
    })
    expect(highWaterMark).toBe(9)
    expect(nextSshTargetGeneration(highWaterMark)).toBe(10)
  })

  it('never reissues a generation a stored target already carries', () => {
    expect(
      resolveSshTargetGenerationHighWaterMark({
        persistedCounter: 0,
        targetGenerations: [7],
        capturedGenerations: []
      })
    ).toBe(7)
  })

  it('keeps the persisted counter when it leads', () => {
    expect(
      resolveSshTargetGenerationHighWaterMark({
        persistedCounter: 12,
        targetGenerations: [3],
        capturedGenerations: [5]
      })
    ).toBe(12)
  })

  it('ignores corrupt values on every input', () => {
    expect(
      resolveSshTargetGenerationHighWaterMark({
        persistedCounter: Number.NaN,
        targetGenerations: [undefined, -4, 2.5],
        capturedGenerations: [null]
      })
    ).toBe(0)
    expect(nextSshTargetGeneration(0)).toBe(1)
  })
})
