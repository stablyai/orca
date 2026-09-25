import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import {
  FEATURE_TIPS,
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  isFeatureTipId,
  type FeatureTip,
  type FeatureTipId
} from '../../../../shared/feature-tips'
import {
  isSessionSearchFeatureTipCompleted,
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
    return FEATURE_TIPS.find((tip) => tip.id === modalTipId) ?? null
  }

  const pendingTips = getOrderedUnseenFeatureTips({
    seenTipIds: new Set(args.seenTipIds),
    completedTipIds: getCompletedFeatureTipIds({
      cliInstalled: args.cliInstalled,
      voiceDictationEnabled: args.settings?.voice?.enabled === true,
      sessionSearchTipCompleted: isSessionSearchFeatureTipCompleted(args.settings, args.webClient),
      featureInteractions: args.featureInteractions
    })
  })

  return pendingTips[0] ?? null
}
