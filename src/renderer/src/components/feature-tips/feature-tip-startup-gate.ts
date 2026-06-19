import type { FeatureTipId } from '../../../../shared/feature-tips'
import {
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips
} from '../../../../shared/feature-tips'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import type { GlobalSettings, OnboardingState } from '../../../../shared/types'
import { shouldShowOnboarding } from '../onboarding/should-show-onboarding'

export type FeatureTipsAppOpenDecision =
  | { kind: 'open'; tipId: FeatureTipId }
  | { kind: 'skip' }
  | { kind: 'suppress-for-onboarding' }

export function isCliFeatureTipCompleted(status: CliInstallStatus): boolean {
  // Why: unsupported launch modes cannot complete setup, but an installed
  // launcher still needs attention until it is reachable on PATH.
  return !status.supported || (status.state === 'installed' && status.pathConfigured)
}

export function getFeatureTipsAppOpenDecision(args: {
  activeModal: string
  cliInstalled: boolean | null
  featureTipsSeenIds: readonly FeatureTipId[]
  featureInteractions: FeatureInteractionState
  onboarding: OnboardingState | null
  persistedUIReady: boolean
  promptedThisSession: boolean
  settings: { voice?: GlobalSettings['voice'] } | null | undefined
  suppressedByOnboardingThisSession: boolean
}): FeatureTipsAppOpenDecision {
  if (args.onboarding !== null && shouldShowOnboarding(args.onboarding)) {
    return { kind: 'suppress-for-onboarding' }
  }

  if (
    args.promptedThisSession ||
    args.suppressedByOnboardingThisSession ||
    !args.persistedUIReady ||
    !args.settings ||
    args.onboarding === null ||
    args.activeModal !== 'none' ||
    args.cliInstalled === null ||
    shouldShowOnboarding(args.onboarding)
  ) {
    return { kind: 'skip' }
  }

  const unseenTips = getOrderedUnseenFeatureTips({
    seenTipIds: new Set<FeatureTipId>(args.featureTipsSeenIds),
    completedTipIds: getCompletedFeatureTipIds({
      cliInstalled: args.cliInstalled,
      voiceDictationEnabled: args.settings.voice?.enabled === true,
      featureInteractions: args.featureInteractions
    })
  })

  const nextTip = unseenTips[0]
  return nextTip ? { kind: 'open', tipId: nextTip.id } : { kind: 'skip' }
}
