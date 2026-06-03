import { describe, expect, it } from 'vitest'
import type { FeatureWallSetupStepId } from '../../../../shared/feature-wall-setup-steps'
import {
  getSettingsSetupGuideProgress,
  SETTINGS_SETUP_GUIDE_STEP_IDS
} from './settings-setup-guide-progress'

describe('settings setup guide progress', () => {
  it('tracks the five-step settings checklist', () => {
    expect(SETTINGS_SETUP_GUIDE_STEP_IDS).toEqual([
      'split-terminal',
      'two-worktrees',
      'notifications',
      'default-agent',
      'task-sources'
    ])
  })

  it('returns a 3/5 progress label source and first incomplete step', () => {
    const stepDone = {
      'split-terminal': true,
      'two-worktrees': true,
      notifications: true
    } satisfies Partial<Record<FeatureWallSetupStepId, boolean>>

    expect(getSettingsSetupGuideProgress(stepDone)).toEqual({
      doneCount: 3,
      total: 5,
      firstIncompleteStepId: 'default-agent'
    })
  })

  it('ignores setup-guide tasks that are not part of the settings checklist', () => {
    const stepDone = {
      'split-terminal': true,
      'two-worktrees': true,
      notifications: true,
      'setup-script': true,
      'add-two-repos': true,
      'agent-capabilities': true
    } satisfies Partial<Record<FeatureWallSetupStepId, boolean>>

    expect(getSettingsSetupGuideProgress(stepDone)).toEqual({
      doneCount: 3,
      total: 5,
      firstIncompleteStepId: 'default-agent'
    })
  })

  it('marks the settings checklist complete when all five settings steps are done', () => {
    const stepDone = Object.fromEntries(
      SETTINGS_SETUP_GUIDE_STEP_IDS.map((stepId) => [stepId, true])
    ) as Record<FeatureWallSetupStepId, boolean>

    expect(getSettingsSetupGuideProgress(stepDone)).toEqual({
      doneCount: 5,
      total: 5,
      firstIncompleteStepId: null
    })
  })
})
