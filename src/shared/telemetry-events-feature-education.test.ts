import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('feature education telemetry event schemas', () => {
  it('accepts contextual tour shown payloads', () => {
    const parsed = eventSchemas.contextual_tour_shown.safeParse({
      tour_id: 'browser',
      source: 'browser_visible',
      was_feature_previously_interacted: false
    })

    expect(parsed.success).toBe(true)
  })

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

  it('accepts setup-guide contextual tour sources for shown and outcome telemetry', () => {
    const shown = eventSchemas.contextual_tour_shown.safeParse({
      tour_id: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      was_feature_previously_interacted: false
    })
    const outcome = eventSchemas.contextual_tour_outcome.safeParse({
      tour_id: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      outcome: 'completed',
      steps_seen: 2,
      total_steps: 5
    })

    expect(shown.success).toBe(true)
    expect(outcome.success).toBe(true)
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
