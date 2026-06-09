import { describe, expect, it } from 'vitest'
import {
  FEATURE_WALL_SETUP_STEPS,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import { getSettingsSetupGuideProgress } from './settings-setup-guide-progress'

describe('settings setup guide progress', () => {
  it('tracks the full setup checklist total', () => {
    const progress = getSettingsSetupGuideProgress({
      ready: true,
      stepDone: {}
    })

    expect(progress).toEqual({
      ready: true,
      doneCount: 0,
      total: FEATURE_WALL_SETUP_STEPS.length,
      firstIncompleteStepId: 'split-terminal'
    })
  })

  it('does not mark Settings complete when only the old five-step subset is done', () => {
    const stepDone = {
      'split-terminal': true,
      'two-worktrees': true,
      notifications: true,
      'default-agent': true,
      'task-sources': true
    } satisfies Partial<Record<FeatureWallSetupStepId, boolean>>

    expect(getSettingsSetupGuideProgress({ ready: true, stepDone })).toEqual({
      ready: true,
      doneCount: 5,
      total: FEATURE_WALL_SETUP_STEPS.length,
      firstIncompleteStepId: 'agent-capabilities'
    })
  })

  it('marks Settings complete when every setup guide step is done', () => {
    const stepDone = Object.fromEntries(
      FEATURE_WALL_SETUP_STEPS.map((step) => [step.id, true])
    ) as Record<FeatureWallSetupStepId, boolean>

    expect(getSettingsSetupGuideProgress({ ready: true, stepDone })).toEqual({
      ready: true,
      doneCount: FEATURE_WALL_SETUP_STEPS.length,
      total: FEATURE_WALL_SETUP_STEPS.length,
      firstIncompleteStepId: null
    })
  })

  it('preserves progress readiness for the sidebar row gate', () => {
    const progress = getSettingsSetupGuideProgress({
      ready: false,
      stepDone: {
        'split-terminal': true
      }
    })

    expect(progress.ready).toBe(false)
    expect(progress.doneCount).toBe(1)
  })
})
