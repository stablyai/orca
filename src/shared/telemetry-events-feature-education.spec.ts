import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('feature education telemetry event schemas', () => {
  it('accepts contextual tour outcome payloads with bounded step counts', () => {
    const parsed = eventSchemas.contextual_tour_outcome.safeParse({
      tour_id: 'tasks',
      source: 'tasks_open',
      outcome: 'completed',
      steps_seen: 2,
      total_steps: 3
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects contextual tour outcome payloads with impossible progress', () => {
    const parsed = eventSchemas.contextual_tour_outcome.safeParse({
      tour_id: 'tasks',
      source: 'tasks_open',
      outcome: 'completed',
      steps_seen: 4,
      total_steps: 3
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects raw contextual tour sources', () => {
    const parsed = eventSchemas.contextual_tour_shown.safeParse({
      tour_id: 'browser',
      source: 'http://localhost:3000/private',
      was_feature_previously_interacted: false
    })

    expect(parsed.success).toBe(false)
  })
})

describe('approved project grouping contextual tip telemetry', () => {
  it('admits the existing shown/outcome payload shape and still refuses unknown tours', () => {
    const shown = {
      tour_id: 'project-grouping-upgrade',
      source: 'unknown',
      was_feature_previously_interacted: false
    }
    const outcome = {
      tour_id: 'project-grouping-upgrade',
      source: 'unknown',
      outcome: 'completed',
      steps_seen: 1,
      total_steps: 1
    }
    expect(eventSchemas.contextual_tour_shown.safeParse(shown).success).toBe(true)
    expect(eventSchemas.contextual_tour_outcome.safeParse(outcome).success).toBe(true)
    expect(
      eventSchemas.contextual_tour_shown.safeParse({ ...shown, tour_id: 'unplanned-tour' }).success
    ).toBe(false)
    expect(
      eventSchemas.contextual_tour_outcome.safeParse({ ...outcome, path: '/private' }).success
    ).toBe(false)
  })
})
