import { describe, expect, it } from 'vitest'
import {
  createOnboardingTourOutcomeTracker,
  markOnboardingTourIntroReached,
  markOnboardingTourStarted,
  recordOnboardingTourDepthSummary,
  resolveOnboardingTourOutcome,
  resolvePendingOnboardingTourOutcome
} from './onboarding-tour-outcome-tracker'

const depthSummary = {
  furthest_step: 'review_ship',
  last_group_id: 'review',
  visited_workflow_count: 5,
  visited_substep_count: 9,
  completed_workflow_count: 4,
  completed_substep_count: 7
} as const

describe('onboarding tour outcome tracker', () => {
  it('emits one skipped outcome for one intro skip', () => {
    const tracker = createOnboardingTourOutcomeTracker()
    markOnboardingTourIntroReached(tracker, 100)

    expect(resolveOnboardingTourOutcome(tracker, 'skipped_intro', 250, 'button')).toEqual({
      outcome: 'skipped_intro',
      intro_duration_ms: 150,
      advanced_via: 'button'
    })
    expect(resolveOnboardingTourOutcome(tracker, 'skipped_intro', 260, 'button')).toBeNull()
  })

  it('emits one completed outcome with inline tour depth', () => {
    const tracker = createOnboardingTourOutcomeTracker()
    markOnboardingTourIntroReached(tracker, 100)
    markOnboardingTourStarted(tracker, 175)
    recordOnboardingTourDepthSummary(tracker, depthSummary)

    expect(resolveOnboardingTourOutcome(tracker, 'completed_inline', 575, 'button')).toEqual({
      outcome: 'completed_inline',
      intro_duration_ms: 75,
      tour_dwell_ms: 400,
      furthest_step: 'review_ship',
      visited_workflow_count: 5,
      visited_substep_count: 9,
      completed_workflow_count: 4,
      completed_substep_count: 7,
      advanced_via: 'button'
    })
    expect(resolvePendingOnboardingTourOutcome(tracker, 600)).toBeNull()
  })

  it('does not resolve a back or step jump partial before session resolution', () => {
    const tracker = createOnboardingTourOutcomeTracker()
    markOnboardingTourIntroReached(tracker, 100)
    markOnboardingTourStarted(tracker, 125)

    expect(tracker.startedInline).toBe(true)
    recordOnboardingTourDepthSummary(tracker, {
      visited_workflow_count: 1,
      visited_substep_count: 0,
      completed_workflow_count: 1,
      completed_substep_count: 0
    })
    expect(resolveOnboardingTourOutcome(tracker, 'completed_inline', 225, 'button')).toMatchObject({
      outcome: 'completed_inline'
    })
    expect(resolvePendingOnboardingTourOutcome(tracker, 250)).toBeNull()
  })

  it('classifies a started tour as partial even if the final action is skip', () => {
    const tracker = createOnboardingTourOutcomeTracker()
    markOnboardingTourIntroReached(tracker, 100)
    markOnboardingTourStarted(tracker, 150)
    recordOnboardingTourDepthSummary(tracker, {
      furthest_step: 'tasks',
      last_group_id: 'tasks',
      visited_workflow_count: 2,
      visited_substep_count: 0,
      completed_workflow_count: 1,
      completed_substep_count: 0
    })

    expect(resolveOnboardingTourOutcome(tracker, 'skipped_intro', 400, 'button')).toEqual({
      outcome: 'started_partial',
      intro_duration_ms: 50,
      tour_dwell_ms: 250,
      furthest_step: 'tasks',
      visited_workflow_count: 2,
      visited_substep_count: 0,
      completed_workflow_count: 1,
      completed_substep_count: 0,
      advanced_via: 'button'
    })
  })

  it('emits at most one pending partial on session close or unmount', () => {
    const tracker = createOnboardingTourOutcomeTracker()
    markOnboardingTourIntroReached(tracker, 100)
    markOnboardingTourStarted(tracker, 150)
    recordOnboardingTourDepthSummary(tracker, {
      furthest_step: 'workbench_editor',
      last_group_id: 'workbench',
      visited_workflow_count: 1,
      visited_substep_count: 2,
      completed_workflow_count: 0,
      completed_substep_count: 2
    })

    expect(resolvePendingOnboardingTourOutcome(tracker, 450)).toEqual({
      outcome: 'started_partial',
      intro_duration_ms: 50,
      tour_dwell_ms: 300,
      furthest_step: 'workbench_editor',
      visited_workflow_count: 1,
      visited_substep_count: 2,
      completed_workflow_count: 0,
      completed_substep_count: 2
    })
    expect(resolvePendingOnboardingTourOutcome(tracker, 475)).toBeNull()
  })
})
