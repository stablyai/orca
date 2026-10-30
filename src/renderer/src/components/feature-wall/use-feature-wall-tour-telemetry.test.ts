import { describe, expect, it } from 'vitest'
import {
  buildFeatureWallClosedTelemetry,
  createFeatureWallTourTelemetryState,
  markFeatureWallTourExitAction,
  openFeatureWallTourTelemetrySession
} from './use-feature-wall-tour-telemetry'

describe('feature wall tour close telemetry session', () => {
  it('emits one close summary for one explicit open', () => {
    const state = createFeatureWallTourTelemetryState()
    const opened = openFeatureWallTourTelemetrySession(state, 100)
    markFeatureWallTourExitAction(state, 'done')

    expect(opened).toBe(true)
    expect(
      buildFeatureWallClosedTelemetry(state, 350, 'help_menu', {
        furthest_step: 'agents_usage',
        last_group_id: 'agents-orchestration',
        visited_workflow_count: 3,
        visited_substep_count: 2,
        completed_workflow_count: 1,
        completed_substep_count: 1
      })
    ).toEqual({
      dwell_ms: 250,
      source: 'help_menu',
      exit_action: 'done',
      furthest_step: 'agents_usage',
      last_group_id: 'agents-orchestration',
      visited_workflow_count: 3,
      visited_substep_count: 2,
      completed_workflow_count: 1,
      completed_substep_count: 1
    })
    expect(
      buildFeatureWallClosedTelemetry(state, 375, 'help_menu', {
        visited_workflow_count: 0,
        visited_substep_count: 0,
        completed_workflow_count: 0,
        completed_substep_count: 0
      })
    ).toBeNull()
  })

  it('ignores duplicate opens until the current session closes', () => {
    const state = createFeatureWallTourTelemetryState()

    expect(openFeatureWallTourTelemetrySession(state, 100)).toBe(true)
    expect(openFeatureWallTourTelemetrySession(state, 150)).toBe(false)
    expect(
      buildFeatureWallClosedTelemetry(state, 200, 'onboarding', {
        visited_workflow_count: 1,
        visited_substep_count: 0,
        completed_workflow_count: 1,
        completed_substep_count: 0
      })
    ).toMatchObject({ dwell_ms: 100, source: 'onboarding' })
  })
})
