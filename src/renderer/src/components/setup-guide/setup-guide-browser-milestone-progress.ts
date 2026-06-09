import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  FEATURE_WALL_SETUP_STEPS,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'

export function useSetupGuideBrowserMilestoneProgress(
  rawProgress: FeatureWallSetupProgress
): FeatureWallSetupProgress {
  const setupGuideSidebarDismissed = useAppStore((s) => s.setupGuideSidebarDismissed)
  const browserMilestoneMigrated = useAppStore((s) => s.setupGuideBrowserMilestoneMigrated)
  const browserMilestoneLegacyComplete = useAppStore(
    (s) => s.setupGuideBrowserMilestoneLegacyComplete
  )
  const markBrowserMilestoneMigrated = useAppStore((s) => s.markSetupGuideBrowserMilestoneMigrated)
  const pendingLegacyComplete =
    !browserMilestoneMigrated && rawProgress.ready
      ? shouldMarkBrowserMilestoneLegacyComplete({
          stepDone: rawProgress.stepDone,
          setupGuideSidebarDismissed
        })
      : false
  const effectiveLegacyComplete = browserMilestoneLegacyComplete || pendingLegacyComplete

  useEffect(() => {
    if (browserMilestoneMigrated || !rawProgress.ready) {
      return
    }
    markBrowserMilestoneMigrated(pendingLegacyComplete)
  }, [
    browserMilestoneMigrated,
    markBrowserMilestoneMigrated,
    pendingLegacyComplete,
    rawProgress.ready
  ])

  return useMemo(
    () => getSetupGuideBrowserMilestoneAwareProgress(rawProgress, effectiveLegacyComplete),
    [effectiveLegacyComplete, rawProgress]
  )
}

export function shouldMarkBrowserMilestoneLegacyComplete(input: {
  stepDone: Partial<Record<FeatureWallSetupStepId, boolean>>
  setupGuideSidebarDismissed: boolean
}): boolean {
  if (input.setupGuideSidebarDismissed) {
    return true
  }
  return FEATURE_WALL_SETUP_STEPS.every((step) => step.id === 'browser' || input.stepDone[step.id])
}

export function getSetupGuideBrowserMilestoneAwareProgress(
  progress: FeatureWallSetupProgress,
  browserMilestoneLegacyComplete: boolean
): FeatureWallSetupProgress {
  if (!browserMilestoneLegacyComplete) {
    return progress
  }
  const stepDone = Object.fromEntries(
    FEATURE_WALL_SETUP_STEPS.map((step) => [step.id, true])
  ) as Record<FeatureWallSetupStepId, boolean>
  // Why: profiles that finished or dismissed the pre-browser checklist keep
  // that prior checklist contract after the browser milestone is introduced.
  return {
    ...progress,
    stepDone,
    coreDoneCount: FEATURE_WALL_SETUP_STEPS.length,
    coreTotal: FEATURE_WALL_SETUP_STEPS.length
  }
}
