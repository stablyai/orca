import { describe, expect, it } from 'vitest'
import {
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  normalizeFeatureTipIds,
  type FeatureTipId
} from './feature-tips'

describe('feature tips', () => {
  it('orders new unseen tips before older unseen tips', () => {
    const tips = getOrderedUnseenFeatureTips({ seenTipIds: new Set<FeatureTipId>() })

    expect(tips.map((tip) => tip.id)).toEqual(['voice-dictation', 'agent-status-sidebar'])
  })

  it('skips tips the user has already seen', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(['voice-dictation'])
    })

    expect(tips.map((tip) => tip.id)).toEqual(['agent-status-sidebar'])
  })

  it('skips tips for features the user has already completed', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(),
      completedTipIds: getCompletedFeatureTipIds({ voiceDictationEnabled: true })
    })

    expect(tips.map((tip) => tip.id)).toEqual(['agent-status-sidebar'])
  })

  it('normalizes persisted tip ids', () => {
    expect(normalizeFeatureTipIds(['feature-tour', 'bogus', 'voice-dictation'])).toEqual([
      'voice-dictation'
    ])
  })
})
