import { describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/orca-profiles/constants'
import { getDefaultOnboardingState } from '../../../../shared/onboarding/onboarding-defaults'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding/onboarding-state-types'
import type { ChatUiLaunchTipVariant } from '../../../../shared/feature-education/chat-ui-launch-tip-audience'
import { getFeatureTipsAppOpenDecision } from './feature-tip-startup-gate'

const existingUserOnboarding: OnboardingState = {
  ...getDefaultOnboardingState(),
  closedAt: Date.parse('2026-05-17T00:00:00.000Z'),
  outcome: 'completed',
  lastCompletedStep: 4
}

// Session search defaults on so tests about the older tips don't see the session-search tip first.
function makeSettings(
  voiceEnabled = false,
  sessionSearchEnabled = true
): Pick<GlobalSettings, 'voice' | 'aiVaultSearch'> {
  return {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: voiceEnabled
    },
    aiVaultSearch: { enabled: sessionSearchEnabled, historyDays: null }
  }
}

describe('feature tip startup gate', () => {
  function decideForExistingUser(args: {
    sessionSearchEnabled: boolean
    webClient: boolean
    featureTipsSeenIds?: ('agent-session-search' | 'orca-cli' | 'bots-teammate')[]
    chatUiLaunchTipVariant?: ChatUiLaunchTipVariant | null
    hasBot?: boolean | null
    botsEnabled?: boolean
  }): ReturnType<typeof getFeatureTipsAppOpenDecision> {
    return getFeatureTipsAppOpenDecision({
      activeModal: 'none',
      cliInstalled: false,
      hasBot: args.hasBot === undefined ? true : args.hasBot,
      featureTipsSeenIds: args.featureTipsSeenIds ?? [],
      featureInteractions: {},
      chatUiLaunchTipVariant:
        args.chatUiLaunchTipVariant === undefined ? 'none' : args.chatUiLaunchTipVariant,
      onboarding: existingUserOnboarding,
      persistedUIReady: true,
      promptedThisSession: false,
      settings: {
        ...makeSettings(false, args.sessionSearchEnabled),
        botsEnabled: args.botsEnabled
      },
      suppressedByOnboardingThisSession: false,
      webClient: args.webClient
    })
  }

  it('opens the bots tip after Chat UI only while bots are on and this computer has none', () => {
    const decide = (
      hasBot: boolean | null,
      { botsEnabled, webClient = false }: { botsEnabled?: boolean; webClient?: boolean } = {}
    ) => decideForExistingUser({ sessionSearchEnabled: true, webClient, hasBot, botsEnabled })
    expect(decide(false)).toEqual({ kind: 'open', tipId: 'bots-teammate' })
    expect(
      decideForExistingUser({
        sessionSearchEnabled: true,
        webClient: false,
        hasBot: false,
        chatUiLaunchTipVariant: 'chat-ui-off'
      })
    ).toEqual({ kind: 'open', tipId: 'chat-ui-here' })
    expect(decide(true)).toEqual({ kind: 'open', tipId: 'orca-cli' })
    expect(decide(false, { botsEnabled: false })).toEqual({ kind: 'open', tipId: 'orca-cli' })
    expect(decide(null, { webClient: true })).toEqual({ kind: 'open', tipId: 'orca-cli' })
    expect(decide(null, { botsEnabled: false })).toEqual({ kind: 'open', tipId: 'orca-cli' })
    // Waits for the bot list rather than showing a later tip first, unless the tip was seen.
    expect(decide(null)).toEqual({ kind: 'skip' })
    expect(
      decideForExistingUser({
        sessionSearchEnabled: true,
        webClient: false,
        hasBot: null,
        featureTipsSeenIds: ['bots-teammate']
      })
    ).toEqual({ kind: 'open', tipId: 'orca-cli' })
  })
})
