import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('feature wall schemas', () => {
  it('rejects invalid close depth fields', () => {
    expect(
      eventSchemas.feature_wall_closed.safeParse({
        dwell_ms: 1200,
        source: 'help_menu',
        exit_action: 'left',
        furthest_step: 'review_raw_url'
      }).success
    ).toBe(false)
    expect(
      eventSchemas.feature_wall_closed.safeParse({
        dwell_ms: 1200,
        visited_workflow_count: 6
      }).success
    ).toBe(false)
    expect(
      eventSchemas.feature_wall_closed.safeParse({
        dwell_ms: 1200,
        repo_path: '/Users/alice/project'
      }).success
    ).toBe(false)
  })
})
