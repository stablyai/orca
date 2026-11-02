import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  FEATURE_WALL_SETUP_STEPS,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'

export function useSetupGuideBrowserMilestoneProgress(
  rawProgress: FeatureWallSetupProgress,
  preBrowserSetupComplete: boolean
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
          preBrowserSetupComplete,
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
  preBrowserSetupComplete: boolean
  setupGuideSidebarDismissed: boolean
}): boolean {
  return input.setupGuideSidebarDismissed || input.preBrowserSetupComplete
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
  // Preserve the checklist contract for profiles that completed or dismissed it before the browser milestone.
  return {
    ...progress,
    stepDone,
    coreDoneCount: FEATURE_WALL_SETUP_STEPS.length,
    coreTotal: FEATURE_WALL_SETUP_STEPS.length
  }
}
