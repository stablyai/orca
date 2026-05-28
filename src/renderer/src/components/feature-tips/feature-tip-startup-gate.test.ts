import { describe, expect, it } from 'vitest'
import { getDefaultOnboardingState, getDefaultVoiceSettings } from '../../../../shared/constants'
import type { GlobalSettings, OnboardingState } from '../../../../shared/types'
import { getFeatureTipsAppOpenDecision } from './feature-tip-startup-gate'

const existingUserOnboarding: OnboardingState = {
  ...getDefaultOnboardingState(),
  closedAt: Date.parse('2026-05-17T00:00:00.000Z'),
  outcome: 'completed',
  lastCompletedStep: 4
}

const firstTimeOnboarding: OnboardingState = getDefaultOnboardingState()

function makeSettings(voiceEnabled = false): Pick<GlobalSettings, 'voice'> {
  return {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: voiceEnabled
    }
  }
}

describe('feature tip startup gate', () => {
  it('opens the feature tip for an existing user on app open', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        featureTipsSeenIds: [],
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'open', tipId: 'voice-dictation' })
  })

  it('suppresses feature tips for first-time users while onboarding is showing', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        featureTipsSeenIds: [],
        onboarding: firstTimeOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'suppress-for-onboarding' })
  })

  it('does not open later in the same session after onboarding suppressed it', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        featureTipsSeenIds: [],
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: true
      })
    ).toEqual({ kind: 'skip' })
  })

  it('does not reopen after the tip was marked seen', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        featureTipsSeenIds: ['voice-dictation', 'agent-status-sidebar'],
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('opens the next tip after voice dictation is already enabled', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        featureTipsSeenIds: [],
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(true),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'open', tipId: 'agent-status-sidebar' })
  })
})
