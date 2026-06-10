import { useMemo } from 'react'
import {
  FEATURE_WALL_SETUP_STEPS,
  getFirstIncompleteFeatureWallSetupStepId,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'

export type SettingsSetupGuideProgress = {
  ready: boolean
  doneCount: number
  total: number
  firstIncompleteStepId: FeatureWallSetupStepId | null
}

export function getSettingsSetupGuideProgress(progress: {
  ready: boolean
  stepDone: Partial<Record<FeatureWallSetupStepId, boolean>>
}): SettingsSetupGuideProgress {
  const doneCount = FEATURE_WALL_SETUP_STEPS.filter((step) => progress.stepDone[step.id]).length
  const firstIncompleteStepId =
    doneCount === FEATURE_WALL_SETUP_STEPS.length
      ? null
      : getFirstIncompleteFeatureWallSetupStepId(progress.stepDone)

  return {
    ready: progress.ready,
    doneCount,
    total: FEATURE_WALL_SETUP_STEPS.length,
    firstIncompleteStepId
  }
}

export function useSettingsSetupGuideProgress(
  shouldRefreshCoreState: boolean
): SettingsSetupGuideProgress {
  const fullProgress = useSettingsSetupGuideFullProgress(shouldRefreshCoreState, false, false)

  return useMemo(() => getSettingsSetupGuideProgress(fullProgress), [fullProgress])
}

export function useSettingsSetupGuideFullProgress(
  shouldRefreshCoreState: boolean,
  orchestrationSkillInstalled: boolean,
  browserUseSkillInstalled: boolean
): FeatureWallSetupProgress {
  return useSetupGuideProgress(
    shouldRefreshCoreState,
    orchestrationSkillInstalled,
    browserUseSkillInstalled
  )
}
