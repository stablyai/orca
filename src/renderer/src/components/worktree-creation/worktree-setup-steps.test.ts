import { describe, expect, it } from 'vitest'
import { deriveWorktreeSetupSteps } from './worktree-setup-steps'

const T0 = 1_000_000

function rows(steps: ReturnType<typeof deriveWorktreeSetupSteps>) {
  return steps.map(({ id, state, elapsedMs, percent }) => [id, state, elapsedMs, percent])
}

describe('deriveWorktreeSetupSteps', () => {
  it('times finished phases from the log and shows checkout progress on the running step', () => {
    const steps = deriveWorktreeSetupSteps(
      {
        status: 'creating',
        phase: 'creating',
        indeterminate: false,
        startedAt: T0,
        phaseLog: [
          { phase: 'preparing', at: T0 },
          { phase: 'fetching', at: T0 + 1_000 },
          { phase: 'creating', at: T0 + 4_000 }
        ],
        checkoutProgress: { percent: 40, completed: 4, total: 10 }
      },
      T0 + 10_000
    )
    expect(rows(steps)).toEqual([
      ['prepare', 'done', 1_000, null],
      ['fetch', 'done', 3_000, null],
      ['create', 'running', 6_000, 40],
      ['start-agent', 'pending', null, null]
    ])
  })

  it('lists phases not reached yet as pending and omits prepare when it never ran', () => {
    const steps = deriveWorktreeSetupSteps(
      {
        status: 'creating',
        phase: 'fetching',
        indeterminate: false,
        startedAt: T0,
        phaseLog: [{ phase: 'fetching', at: T0 }]
      },
      T0 + 2_000
    )
    expect(rows(steps)).toEqual([
      ['fetch', 'running', 2_000, null],
      ['create', 'pending', null, null],
      ['start-agent', 'pending', null, null]
    ])
  })

  it('never claims a phase ran when creation passed over it', () => {
    const steps = deriveWorktreeSetupSteps(
      {
        status: 'creating',
        phase: 'creating',
        indeterminate: false,
        startedAt: T0,
        phaseLog: [
          { phase: 'preparing', at: T0 },
          { phase: 'creating', at: T0 + 500 }
        ]
      },
      T0 + 1_500
    )
    expect(steps.map((step) => step.id)).toEqual(['prepare', 'create', 'start-agent'])
  })

  it('marks the last entered step failed on error and keeps later steps pending', () => {
    const steps = deriveWorktreeSetupSteps(
      {
        status: 'error',
        phase: 'creating',
        indeterminate: false,
        startedAt: T0,
        phaseLog: [
          { phase: 'fetching', at: T0 },
          { phase: 'creating', at: T0 + 2_000 }
        ],
        checkoutProgress: { percent: 90, completed: 9, total: 10 }
      },
      T0 + 5_000
    )
    expect(rows(steps)).toEqual([
      ['fetch', 'done', 2_000, null],
      ['create', 'failed', null, null],
      ['start-agent', 'pending', null, null]
    ])
  })

  it('collapses hosts without phase events into one setup step', () => {
    const entry = {
      phase: 'creating' as const,
      indeterminate: true,
      startedAt: T0,
      phaseLog: [{ phase: 'creating' as const, at: T0 }]
    }
    expect(rows(deriveWorktreeSetupSteps({ ...entry, status: 'creating' }, T0 + 3_000))).toEqual([
      ['setup', 'running', 3_000, null],
      ['start-agent', 'pending', null, null]
    ])
    expect(rows(deriveWorktreeSetupSteps({ ...entry, status: 'error' }, T0 + 3_000))).toEqual([
      ['setup', 'failed', null, null],
      ['start-agent', 'pending', null, null]
    ])
  })
})
