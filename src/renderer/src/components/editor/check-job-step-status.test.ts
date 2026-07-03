import { describe, expect, it } from 'vitest'
import { resolveStepOutcome, summarizeJobSteps } from './check-job-step-status'

describe('resolveStepOutcome', () => {
  it('prefers conclusion over status', () => {
    expect(resolveStepOutcome({ status: 'completed', conclusion: 'failure' })).toBe('failure')
  })

  it('maps failure-like states to failure', () => {
    for (const conclusion of [
      'failure',
      'failed',
      'action_required',
      'cancelled',
      'stale',
      'startup_failure',
      'timed_out'
    ]) {
      expect(resolveStepOutcome({ status: null, conclusion })).toBe('failure')
    }
  })

  it('maps skipped and neutral to skipped', () => {
    expect(resolveStepOutcome({ status: null, conclusion: 'skipped' })).toBe('skipped')
    expect(resolveStepOutcome({ status: null, conclusion: 'neutral' })).toBe('skipped')
  })

  it('treats unknown or absent states as pending', () => {
    expect(resolveStepOutcome({ status: null, conclusion: null })).toBe('pending')
    expect(resolveStepOutcome({ status: 'in_progress', conclusion: null })).toBe('pending')
  })
})

describe('summarizeJobSteps', () => {
  it('buckets steps and counts the total', () => {
    const step = (name: string, status: string | null, conclusion: string | null) => ({
      name,
      status,
      conclusion,
      startedAt: null,
      completedAt: null
    })
    const breakdown = summarizeJobSteps({
      steps: [
        step('Typecheck', 'completed', 'failure'),
        step('Lint', 'completed', 'success'),
        step('Build', 'completed', 'success'),
        step('Smoke test', 'completed', 'skipped'),
        step('Deploy', 'queued', null)
      ]
    })
    expect(breakdown.failed.map((step) => step.name)).toEqual(['Typecheck'])
    expect(breakdown.succeeded.map((step) => step.name)).toEqual(['Lint', 'Build'])
    expect(breakdown.skipped.map((step) => step.name)).toEqual(['Smoke test'])
    expect(breakdown.pending.map((step) => step.name)).toEqual(['Deploy'])
    expect(breakdown.total).toBe(5)
  })
})
