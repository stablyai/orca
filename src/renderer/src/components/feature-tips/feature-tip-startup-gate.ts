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

export const APP_OPEN_FEATURE_TIP_TOKEN = 'feature-tip:app-open'

export type FeatureTipsAppOpenDecision =
  | { kind: 'open'; tipId: FeatureTipId }
  | { kind: 'skip' }
  | { kind: 'suppress-for-onboarding' }
  /** Something it depends on has not loaded yet. */
  | { kind: 'pending' }

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
  cliInstalled: boolean | null
  featureTipsSeenIds: readonly FeatureTipId[]
  featureInteractions: FeatureInteractionState
  onboarding: OnboardingState | null
  persistedUIReady: boolean
  settings: FeatureTipSettings | null | undefined
  webClient: boolean
}): FeatureTipsAppOpenDecision {
  if (args.onboarding !== null && shouldShowOnboarding(args.onboarding)) {
    return { kind: 'suppress-for-onboarding' }
  }

  if (!args.persistedUIReady || !args.settings || args.onboarding === null) {
    return { kind: 'pending' }
  }

  // Without the CLI status, assume its tip is still open: if even then nothing is pending, the
  // answer is known without waiting for that probe.
  const nextTip = getPendingFeatureTips({
    seenTipIds: args.featureTipsSeenIds,
    cliInstalled: args.cliInstalled ?? false,
    featureInteractions: args.featureInteractions,
    settings: args.settings,
    webClient: args.webClient
  })[0]
  if (!nextTip) {
    return { kind: 'skip' }
  }
  return args.cliInstalled === null ? { kind: 'pending' } : { kind: 'open', tipId: nextTip.id }
}
