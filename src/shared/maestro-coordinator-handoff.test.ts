import { describe, expect, it } from 'vitest'
import { canAdvanceCoordinatorHandoff } from './maestro-coordinator-handoff'

describe('Maestro coordinator handoff contract', () => {
  it('advances one durable phase at a time', () => {
    expect(canAdvanceCoordinatorHandoff('reserved', 'spawned')).toBe(true)
    expect(canAdvanceCoordinatorHandoff('spawned', 'coordinator_claimed')).toBe(false)
    expect(canAdvanceCoordinatorHandoff('authority_committed', 'predecessor_reconciled')).toBe(true)
  })

  it('makes terminal failure phases final', () => {
    expect(canAdvanceCoordinatorHandoff('reserved', 'blocked')).toBe(true)
    expect(canAdvanceCoordinatorHandoff('blocked', 'spawned')).toBe(false)
    expect(canAdvanceCoordinatorHandoff('outcome_unknown', 'reserved')).toBe(false)
  })
})
