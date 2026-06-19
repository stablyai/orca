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

    expect(tips.map((tip) => tip.id)).toEqual(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
  })

  it('skips tips the user has already seen', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(['voice-dictation', 'orca-cli', 'cmd-j-palette'])
    })

    expect(tips.map((tip) => tip.id)).toEqual([])
  })

  it('skips tips for features the user has already completed', () => {
    const tips = getOrderedUnseenFeatureTips({
      // cmd-j is a seen-based tip with no feature completion, so mark it seen here.
      seenTipIds: new Set<FeatureTipId>(['cmd-j-palette']),
      completedTipIds: getCompletedFeatureTipIds({
        cliInstalled: true,
        voiceDictationEnabled: true
      })
    })

    expect(tips.map((tip) => tip.id)).toEqual([])
  })

  it('skips the CLI tip when the CLI is already installed', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(['voice-dictation', 'cmd-j-palette']),
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

    expect(tips.map((tip) => tip.id)).toEqual(['orca-cli', 'cmd-j-palette'])
  })

  it('normalizes persisted tip ids', () => {
    expect(
      normalizeFeatureTipIds([
        'feature-tour',
        'orca-cli',
        'bogus',
        'cmd-j-palette',
        'voice-dictation'
      ])
    ).toEqual(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
  })

  it('describes the command palette tip as a passive acknowledgement', () => {
    const paletteTip = FEATURE_TIPS.find((tip) => tip.id === 'cmd-j-palette')

    expect(paletteTip).toMatchObject({
      action: 'learn-cmd-j-palette',
      priority: 'new',
      eyebrow: 'Tip',
      ctaLabel: 'Got it'
    })
    expect(paletteTip?.description).toContain('worktrees')
    expect(paletteTip?.description).toContain('spin up a new worktree')
  })

  it('describes the CLI tip as an install action with concrete workflows', () => {
    const cliTip = FEATURE_TIPS.find((tip) => tip.id === 'orca-cli')

    expect(cliTip).toMatchObject({
      action: 'setup-cli',
      title: 'Let agents drive Orca with the Orca CLI',
      ctaLabel: 'Install CLI & Skills'
    })
    expect(cliTip?.description).toContain('coordinate child worktrees')
    expect(cliTip?.description).toContain('communicate between worktrees')
  })

  it('does not label the voice dictation tip as new', () => {
    const voiceTip = FEATURE_TIPS.find((tip) => tip.id === 'voice-dictation')

    expect(voiceTip?.eyebrow).toBe('Tip')
    expect(voiceTip?.priority).toBe('unseen')
  })
})
