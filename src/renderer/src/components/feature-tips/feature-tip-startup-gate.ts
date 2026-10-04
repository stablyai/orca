import {
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  type FeatureTip,
  type FeatureTipId
} from '../../../../shared/feature-tips'
import { resolveAiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import { shouldShowOnboarding } from '../onboarding/should-show-onboarding'

export type FeatureTipsAppOpenDecision =
  | { kind: 'open'; tipId: FeatureTipId }
  | { kind: 'skip' }
  | { kind: 'suppress-for-onboarding' }

export function isCliFeatureTipCompleted(status: CliInstallStatus): boolean {
  // Why: unsupported launch modes cannot complete setup, but an installed
  // launcher still needs attention until it is reachable on PATH.
  return !status.supported || (status.state === 'installed' && status.pathConfigured === true)
}

export type FeatureTipSettings = {
  voice?: GlobalSettings['voice']
  aiVaultSearch?: GlobalSettings['aiVaultSearch']
}

export function isSessionSearchFeatureTipCompleted(
  settings: FeatureTipSettings | null | undefined,
  webClient: boolean
): boolean {
  // Why: the browser client cannot index transcripts, so there is nothing to turn on.
  return webClient || resolveAiVaultSearchSettings(settings).enabled
}

/** Unseen tips whose feature the user has not already set up, in display order. */
export function getPendingFeatureTips(args: {
  seenTipIds: readonly FeatureTipId[]
  cliInstalled: boolean
  featureInteractions: FeatureInteractionState
  settings: FeatureTipSettings | null | undefined
  webClient: boolean
}): FeatureTip[] {
  return getOrderedUnseenFeatureTips({
    seenTipIds: new Set(args.seenTipIds),
    completedTipIds: getCompletedFeatureTipIds({
      cliInstalled: args.cliInstalled,
      voiceDictationEnabled: args.settings?.voice?.enabled === true,
      sessionSearchTipCompleted: isSessionSearchFeatureTipCompleted(args.settings, args.webClient),
      featureInteractions: args.featureInteractions
    })
  })
}

export function getFeatureTipsAppOpenDecision(args: {
  activeModal: string
  cliInstalled: boolean | null
  featureTipsSeenIds: readonly FeatureTipId[]
  featureInteractions: FeatureInteractionState
  onboarding: OnboardingState | null
  persistedUIReady: boolean
  promptedThisSession: boolean
  settings: FeatureTipSettings | null | undefined
  suppressedByOnboardingThisSession: boolean
  webClient: boolean
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

  const nextTip = getPendingFeatureTips({
    seenTipIds: args.featureTipsSeenIds,
    cliInstalled: args.cliInstalled,
    featureInteractions: args.featureInteractions,
    settings: args.settings,
    webClient: args.webClient
  })[0]
  return nextTip ? { kind: 'open', tipId: nextTip.id } : { kind: 'skip' }
}
