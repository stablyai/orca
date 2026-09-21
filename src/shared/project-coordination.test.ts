import { describe, expect, it } from 'vitest'
import { applyProjectCoordinationUpdate } from './project-coordination'

describe('project coordination updates', () => {
  it('allows only one writer of a given revision and preserves the first edit', () => {
    const saved = applyProjectCoordinationUpdate(undefined, {
      goal: 'Ship',
      instructions: 'Test first',
      expectedRevision: 0
    })
    expect(saved).toEqual({ goal: 'Ship', instructions: 'Test first', revision: 1 })
    expect(() =>
      applyProjectCoordinationUpdate(saved, {
        goal: 'Overwrite',
        instructions: '',
        expectedRevision: 0
      })
    ).toThrow('changed')
    expect(saved.goal).toBe('Ship')
    expect(
      applyProjectCoordinationUpdate(saved, { goal: 'Next', instructions: '', expectedRevision: 1 })
        .revision
    ).toBe(2)
  })
  it('rejects oversized context and revision overflow', () => {
    expect(() =>
      applyProjectCoordinationUpdate(undefined, {
        goal: 'x'.repeat(4001),
        instructions: '',
        expectedRevision: 0
      })
    ).toThrow()
    expect(() =>
      applyProjectCoordinationUpdate(undefined, {
        goal: '',
        instructions: 'x'.repeat(16001),
        expectedRevision: 0
      })
    ).toThrow()
    expect(() =>
      applyProjectCoordinationUpdate(undefined, {
        goal: '',
        instructions: '',
        expectedRevision: Number.MAX_SAFE_INTEGER
      })
    ).toThrow()
  })
})
