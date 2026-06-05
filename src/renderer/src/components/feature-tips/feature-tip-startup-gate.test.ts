import { describe, expect, it } from 'vitest'
import { getDefaultOnboardingState, getDefaultVoiceSettings } from '../../../../shared/constants'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { GlobalSettings, OnboardingState } from '../../../../shared/types'
import { getFeatureTipsAppOpenDecision, isCliFeatureTipCompleted } from './feature-tip-startup-gate'

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

function makeCliStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    supported: true,
    state: 'installed',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca.app/Contents/MacOS/orca',
    installMethod: 'symlink',
    currentTarget: null,
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

describe('feature tip startup gate', () => {
  it('opens the CLI feature tip first for an existing user on app open', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: false,
        featureTipsSeenIds: [],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'open', tipId: 'orca-cli' })
  })

  it('suppresses feature tips for first-time users while onboarding is showing', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: false,
        featureTipsSeenIds: [],
        featureInteractions: {},
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
        cliInstalled: false,
        featureTipsSeenIds: [],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: true
      })
    ).toEqual({ kind: 'skip' })
  })

  it('opens the CLI tip after the voice tip was marked seen', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: false,
        featureTipsSeenIds: ['voice-dictation'],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'open', tipId: 'orca-cli' })
  })

  it('opens the CLI tip after voice dictation is already enabled', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: false,
        featureTipsSeenIds: [],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(true),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'open', tipId: 'orca-cli' })
  })

  it('does not open after every tip was marked seen', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: false,
        featureTipsSeenIds: ['voice-dictation', 'orca-cli'],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('does not open the voice tip after Settings marked it seen and dictation is disabled', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: true,
        featureTipsSeenIds: ['voice-dictation'],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(false),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('does not open the CLI tip after the CLI is installed', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: true,
        featureTipsSeenIds: ['voice-dictation'],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('waits for CLI install status before opening the CLI tip', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: null,
        featureTipsSeenIds: ['voice-dictation'],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('waits for CLI install status before opening later tips', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: null,
        featureTipsSeenIds: [],
        featureInteractions: {},
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('does not open after the user already interacted with the feature', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: true,
        featureTipsSeenIds: [],
        featureInteractions: {
          'voice-dictation': { firstInteractedAt: 100, interactionCount: 1 }
        },
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('requires an installed CLI to also be configured on PATH', () => {
    expect(isCliFeatureTipCompleted(makeCliStatus())).toBe(true)
    expect(isCliFeatureTipCompleted(makeCliStatus({ pathConfigured: false }))).toBe(false)
  })

  it('treats unsupported CLI setup as completed for feature tips', () => {
    expect(
      isCliFeatureTipCompleted(
        makeCliStatus({
          supported: false,
          state: 'unsupported',
          pathConfigured: false
        })
      )
    ).toBe(true)
  })
})
