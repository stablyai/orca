import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import {
  FEATURE_TIPS,
  isFeatureTipForAudience,
  isFeatureTipId,
  type FeatureTip,
  type FeatureTipId
} from '../../../../shared/feature-tips'
import {
  getFeatureTipAudience,
  getPendingFeatureTips,
  type FeatureTipSettings
} from './feature-tip-startup-gate'

export function getFeatureTipForModal(args: {
  cliInstalled: boolean
  modalData: Record<string, unknown>
  seenTipIds: readonly FeatureTipId[]
  featureInteractions: FeatureInteractionState
  settings: FeatureTipSettings | null | undefined
  webClient: boolean
}): FeatureTip | null {
  const modalTipId = isFeatureTipId(args.modalData.tipId) ? args.modalData.tipId : null
  if (modalTipId) {
    // Why: an explicit id skips seen/completed (startup marks seen before opening), never the audience.
    const tip = FEATURE_TIPS.find((candidate) => candidate.id === modalTipId)
    return tip && isFeatureTipForAudience(tip, getFeatureTipAudience(args.settings)) ? tip : null
  }

  return getPendingFeatureTips(args)[0] ?? null
}
