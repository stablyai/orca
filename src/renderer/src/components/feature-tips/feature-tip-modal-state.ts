import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import {
  FEATURE_TIPS,
  isFeatureTipId,
  type FeatureTip,
  type FeatureTipId
} from '../../../../shared/feature-tips'
import { getPendingFeatureTips, type FeatureTipSettings } from './feature-tip-startup-gate'

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
    return FEATURE_TIPS.find((tip) => tip.id === modalTipId) ?? null
  }

  return getPendingFeatureTips(args)[0] ?? null
}
