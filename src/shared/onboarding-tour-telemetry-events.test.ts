import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('onboarding tour telemetry schemas', () => {
  it('keeps accepting historical onboarding tour step telemetry', () => {
    expect(
      eventSchemas.onboarding_step_viewed.safeParse({
        step: 6,
        value_kind: 'tour'
      }).success
    ).toBe(true)
    expect(
      eventSchemas.onboarding_step_skipped.safeParse({
        step: 6,
        value_kind: 'tour',
        duration_ms: 1200,
        advanced_via: 'button'
      }).success
    ).toBe(true)
  })

  it('rejects invalid semantic value_kind on viewed and skipped steps', () => {
    expect(
      eventSchemas.onboarding_step_viewed.safeParse({
        step: 6,
        value_kind: 'tour_intro'
      }).success
    ).toBe(false)
    expect(
      eventSchemas.onboarding_step_skipped.safeParse({
        step: 6,
        value_kind: 'tour_intro'
      }).success
    ).toBe(false)
  })

  it('accepts the onboarding tour outcome summary payload', () => {
    expect(
      eventSchemas.onboarding_tour_outcome.safeParse({
        outcome: 'completed_inline',
        intro_duration_ms: 500,
        tour_dwell_ms: 2500,
        furthest_step: 'review_ship',
        visited_workflow_count: 5,
        visited_substep_count: 9,
        completed_workflow_count: 4,
        completed_substep_count: 7,
        advanced_via: 'button'
      }).success
    ).toBe(true)
  })

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
