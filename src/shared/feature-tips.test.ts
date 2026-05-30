import { describe, expect, it } from 'vitest'
import {
  FEATURE_TIPS,
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  normalizeFeatureTipIds,
  type FeatureTipId
} from './feature-tips'

describe('feature tips', () => {
  it('orders new unseen tips before older unseen tips', () => {
    const tips = getOrderedUnseenFeatureTips({ seenTipIds: new Set<FeatureTipId>() })

    expect(tips.map((tip) => tip.id)).toEqual(['orca-cli', 'voice-dictation'])
  })

  it('skips tips the user has already seen', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(['voice-dictation', 'orca-cli'])
    })

    expect(tips.map((tip) => tip.id)).toEqual([])
  })

  it('skips tips for features the user has already completed', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(),
      completedTipIds: getCompletedFeatureTipIds({
        cliInstalled: true,
        voiceDictationEnabled: true
      })
    })

    expect(tips.map((tip) => tip.id)).toEqual([])
  })

  it('skips the CLI tip when the CLI is already installed', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(['voice-dictation']),
      completedTipIds: getCompletedFeatureTipIds({
        cliInstalled: true,
        voiceDictationEnabled: false
      })
    })

    expect(tips.map((tip) => tip.id)).toEqual([])
  })

  it('skips tips for features the user has already interacted with', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(),
      completedTipIds: getCompletedFeatureTipIds({
        cliInstalled: false,
        voiceDictationEnabled: false,
        featureInteractions: {
          'voice-dictation': { firstInteractedAt: 100, interactionCount: 1 }
        }
      })
    })

    expect(tips.map((tip) => tip.id)).toEqual(['orca-cli'])
  })

  it('normalizes persisted tip ids', () => {
    expect(
      normalizeFeatureTipIds(['feature-tour', 'orca-cli', 'bogus', 'voice-dictation'])
    ).toEqual(['orca-cli', 'voice-dictation'])
  })

  it('describes the CLI tip as an install action with concrete workflows', () => {
    const cliTip = FEATURE_TIPS.find((tip) => tip.id === 'orca-cli')

    expect(cliTip).toMatchObject({
      action: 'setup-cli',
      title: 'Let agents drive Orca with the Orca CLI',
      ctaLabel: 'Install CLI & Skills'
    })
    expect(cliTip?.description).toContain('coordinate child workspaces')
    expect(cliTip?.description).toContain('communicate between workspaces')
  })

  it('does not label the voice dictation tip as new', () => {
    const voiceTip = FEATURE_TIPS.find((tip) => tip.id === 'voice-dictation')

    expect(voiceTip?.eyebrow).toBe('Tip')
    expect(voiceTip?.priority).toBe('unseen')
  })
})
