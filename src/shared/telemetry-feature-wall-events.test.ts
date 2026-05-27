import { describe, expect, it } from 'vitest'
import { eventSchemas, featureWallTileIdSchema } from './telemetry-events'

describe('feature wall schemas', () => {
  it('accepts the unconditional open and close payloads', () => {
    expect(eventSchemas.feature_wall_opened.safeParse({ source: 'help_menu' }).success).toBe(true)
    expect(eventSchemas.feature_wall_opened.safeParse({ source: 'popup' }).success).toBe(true)
    expect(eventSchemas.feature_wall_opened.safeParse({ source: 'onboarding' }).success).toBe(true)
    expect(eventSchemas.feature_wall_closed.safeParse({ dwell_ms: 1200 }).success).toBe(true)
  })

  it('accepts the close depth summary payload', () => {
    expect(
      eventSchemas.feature_wall_closed.safeParse({
        dwell_ms: 1200,
        source: 'onboarding',
        exit_action: 'onboarding_continue',
        furthest_step: 'review_ship',
        last_group_id: 'review',
        visited_workflow_count: 5,
        visited_substep_count: 9,
        completed_workflow_count: 4,
        completed_substep_count: 7
      }).success
    ).toBe(true)
  })

  it('rejects stale or invalid source variants', () => {
    expect(eventSchemas.feature_wall_opened.safeParse({}).success).toBe(false)
    expect(eventSchemas.feature_wall_opened.safeParse({ surface: 'help_tour' }).success).toBe(false)
    expect(eventSchemas.feature_wall_opened.safeParse({ source: 'help_tour' }).success).toBe(false)
  })

  it('rejects out-of-range dwell time', () => {
    expect(eventSchemas.feature_wall_closed.safeParse({ dwell_ms: -1 }).success).toBe(false)
  })

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

  it('accepts only known tile ids for tile focus telemetry', () => {
    expect(
      eventSchemas.feature_wall_tile_focused.safeParse({
        tile_id: 'tile-12'
      }).success
    ).toBe(true)
    expect(
      eventSchemas.feature_wall_tile_focused.safeParse({
        tile_id: 'tile-99'
      }).success
    ).toBe(false)
  })

  it('accepts only known tile ids for tile click telemetry', () => {
    expect(
      eventSchemas.feature_wall_tile_clicked.safeParse({
        tile_id: 'tile-03'
      }).success
    ).toBe(true)
    expect(
      eventSchemas.feature_wall_tile_clicked.safeParse({
        tile_id: 'tile-99'
      }).success
    ).toBe(false)
  })

  it('accepts the workflow group telemetry payload', () => {
    expect(
      eventSchemas.feature_wall_group_selected.safeParse({
        group_id: 'review',
        source: 'help_menu'
      }).success
    ).toBe(true)
    expect(
      eventSchemas.feature_wall_group_selected.safeParse({
        group_id: 'unknown-workflow',
        source: 'help_menu'
      }).success
    ).toBe(false)
  })

  it('accepts the feature-selected telemetry payload', () => {
    expect(
      eventSchemas.feature_wall_feature_selected.safeParse({
        group_id: 'workbench',
        tile_id: 'tile-02',
        source: 'help_menu'
      }).success
    ).toBe(true)
    expect(
      eventSchemas.feature_wall_feature_selected.safeParse({
        group_id: 'workbench',
        tile_id: 'tile-02'
      }).success
    ).toBe(false)
  })

  it('accepts the docs-clicked telemetry payload', () => {
    expect(
      eventSchemas.feature_wall_docs_clicked.safeParse({
        group_id: 'review',
        tile_id: 'tile-08',
        source: 'help_menu'
      }).success
    ).toBe(true)
  })

  it('feature wall enum schemas accept known values', () => {
    expect(featureWallTileIdSchema.safeParse('tile-01').success).toBe(true)
  })
})
