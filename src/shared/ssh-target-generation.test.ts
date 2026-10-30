import { describe, expect, it } from 'vitest'
import {
  nextSshTargetGeneration,
  resolveSshTargetGenerationHighWaterMark
} from './ssh-target-generation'

describe('resolveSshTargetGenerationHighWaterMark', () => {
  it('never reissues a generation an automation already captured', () => {
    // A rolled-back counter cannot reissue an automation’s captured generation.
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
