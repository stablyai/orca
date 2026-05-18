import type { FeatureTipId } from '../../../../shared/feature-tips'
import {
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips
} from '../../../../shared/feature-tips'
import type { GlobalSettings, OnboardingState } from '../../../../shared/types'
import { shouldShowOnboarding } from '../onboarding/should-show-onboarding'

export type FeatureTipsAppOpenDecision = 'open' | 'skip' | 'suppress-for-onboarding'

export function getFeatureTipsAppOpenDecision(args: {
  activeModal: string
  featureTipsSeenIds: readonly FeatureTipId[]
  onboarding: OnboardingState | null
  persistedUIReady: boolean
  promptedThisSession: boolean
  settings: { voice?: GlobalSettings['voice'] } | null | undefined
  suppressedByOnboardingThisSession: boolean
}): FeatureTipsAppOpenDecision {
  if (args.onboarding !== null && shouldShowOnboarding(args.onboarding)) {
    return 'suppress-for-onboarding'
  }

  if (
    args.promptedThisSession ||
    args.suppressedByOnboardingThisSession ||
    !args.persistedUIReady ||
    !args.settings ||
    args.onboarding === null ||
    args.activeModal !== 'none' ||
    shouldShowOnboarding(args.onboarding)
  ) {
    return 'skip'
  }

  const unseenTips = getOrderedUnseenFeatureTips({
    seenTipIds: new Set<FeatureTipId>(args.featureTipsSeenIds),
    completedTipIds: getCompletedFeatureTipIds({
      voiceDictationEnabled: args.settings.voice?.enabled === true
    })
  })

  return unseenTips.length > 0 ? 'open' : 'skip'
}
