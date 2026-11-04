import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('onboarding tour telemetry schemas', () => {
  it('rejects invalid tour outcome fields and extra raw payload', () => {
    expect(
      eventSchemas.onboarding_tour_outcome.safeParse({
        outcome: 'finished',
        intro_duration_ms: 500
      }).success
    ).toBe(false)
    expect(
      eventSchemas.onboarding_tour_outcome.safeParse({
        outcome: 'started_partial',
        visited_workflow_count: 6
      }).success
    ).toBe(false)
    expect(
      eventSchemas.onboarding_tour_outcome.safeParse({
        outcome: 'started_partial',
        command: 'npm test'
      }).success
    ).toBe(false)
    expect(
      eventSchemas.onboarding_tour_outcome.safeParse({
        outcome: 'skipped_intro',
        tour_dwell_ms: 2500
      }).success
    ).toBe(false)
  })
})
