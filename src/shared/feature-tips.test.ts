import { describe, expect, it } from 'vitest'
import {
  FEATURE_TIPS,
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  isFeatureTipForAudience,
  normalizeFeatureTipIds,
  type FeatureTipAudienceState,
  type FeatureTipId
} from './feature-tips'

const everyone: FeatureTipAudienceState = { nativeChatGraduationOptIn: false }
const optedIn: FeatureTipAudienceState = { nativeChatGraduationOptIn: true }

describe('feature tips', () => {
  it('orders new unseen tips before older unseen tips', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(),
      audience: everyone
    })

    expect(tips.map((tip) => tip.id)).toEqual([
      'agent-session-search',
      'orca-cli',
      'cmd-j-palette',
      'voice-dictation'
    ])
  })

  it('skips tips the user has already seen', () => {
    const tips = getOrderedUnseenFeatureTips({
      audience: everyone,
      seenTipIds: new Set<FeatureTipId>([
        'voice-dictation',
        'orca-cli',
        'cmd-j-palette',
        'agent-session-search'
      ])
    })

    expect(tips.map((tip) => tip.id)).toEqual([])
  })

  it('skips tips for features the user has already completed', () => {
    const tips = getOrderedUnseenFeatureTips({
      audience: everyone,
      // cmd-j is a seen-based tip with no feature completion, so mark it seen here.
      seenTipIds: new Set<FeatureTipId>(['cmd-j-palette']),
      completedTipIds: getCompletedFeatureTipIds({
        cliInstalled: true,
        voiceDictationEnabled: true,
        sessionSearchTipCompleted: true
      })
    })

    expect(tips.map((tip) => tip.id)).toEqual([])
  })

  it('skips the CLI tip when the CLI is already installed', () => {
    const tips = getOrderedUnseenFeatureTips({
      audience: everyone,
      seenTipIds: new Set<FeatureTipId>(['voice-dictation', 'cmd-j-palette']),
      completedTipIds: getCompletedFeatureTipIds({
        cliInstalled: true,
        voiceDictationEnabled: false,
        sessionSearchTipCompleted: true
      })
    })

    expect(tips.map((tip) => tip.id)).toEqual([])
  })

  it('skips tips for features the user has already interacted with', () => {
    const tips = getOrderedUnseenFeatureTips({
      audience: everyone,
      seenTipIds: new Set<FeatureTipId>(),
      completedTipIds: getCompletedFeatureTipIds({
        cliInstalled: false,
        voiceDictationEnabled: false,
        sessionSearchTipCompleted: true,
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
    expect(voiceTip?.title).toBe('Dictate into any pane')
    expect(voiceTip?.ctaLabel).toBe('Set up voice dictation')
  })

  it('offers the native chat upgrade tip first, and only to the pre-graduation opt-in cohort', () => {
    const forCohort = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(),
      audience: optedIn
    })
    const forEveryoneElse = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(),
      audience: everyone
    })

    expect(forCohort[0]?.id).toBe('native-chat-upgrade')
    expect(forEveryoneElse.map((tip) => tip.id)).not.toContain('native-chat-upgrade')
  })

  it('keeps the cohort after the tip is seen; seen alone retires it', () => {
    const tips = getOrderedUnseenFeatureTips({
      seenTipIds: new Set<FeatureTipId>(['native-chat-upgrade']),
      audience: optedIn
    })

    expect(tips.map((tip) => tip.id)).not.toContain('native-chat-upgrade')
  })

  it('limits only the native chat upgrade tip by audience', () => {
    const limited = FEATURE_TIPS.filter((tip) => !isFeatureTipForAudience(tip, everyone))

    expect(limited.map((tip) => tip.id)).toEqual(['native-chat-upgrade'])
    expect(FEATURE_TIPS.every((tip) => isFeatureTipForAudience(tip, optedIn))).toBe(true)
  })

  it('keeps a seen native chat upgrade receipt when normalizing', () => {
    expect(normalizeFeatureTipIds(['native-chat-upgrade', 'orca-cli'])).toEqual([
      'native-chat-upgrade',
      'orca-cli'
    ])
  })
})
