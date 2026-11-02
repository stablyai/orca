import { describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import {
  chatUiLaunchTipVariant,
  type ChatUiLaunchTipVariant
} from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import {
  getFeatureTipsAppOpenDecision,
  isCliFeatureTipCompleted,
  isSessionSearchFeatureTipCompleted
} from './feature-tip-startup-gate'

const existingUserOnboarding: OnboardingState = {
  ...getDefaultOnboardingState(),
  closedAt: Date.parse('2026-05-17T00:00:00.000Z'),
  outcome: 'completed',
  lastCompletedStep: 4
}

const firstTimeOnboarding: OnboardingState = getDefaultOnboardingState()

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
        chatUiLaunchTipVariant: 'none',
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false,
        webClient: false
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
        chatUiLaunchTipVariant: 'none',
        onboarding: firstTimeOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false,
        webClient: false
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
        chatUiLaunchTipVariant: 'none',
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: true,
        webClient: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('opens the command palette tip after the CLI tip was marked seen', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: true,
        featureTipsSeenIds: ['orca-cli'],
        featureInteractions: {},
        chatUiLaunchTipVariant: 'none',
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false,
        webClient: false
      })
    ).toEqual({ kind: 'open', tipId: 'cmd-j-palette' })
  })

  it('does not open after every tip was marked seen', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: false,
        featureTipsSeenIds: ['voice-dictation', 'orca-cli', 'cmd-j-palette'],
        featureInteractions: {},
        chatUiLaunchTipVariant: 'none',
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false,
        webClient: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('does not open the voice tip after Settings marked it seen and dictation is disabled', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: true,
        featureTipsSeenIds: ['voice-dictation', 'cmd-j-palette'],
        featureInteractions: {},
        chatUiLaunchTipVariant: 'none',
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(false),
        suppressedByOnboardingThisSession: false,
        webClient: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('does not open the CLI tip after the CLI is installed', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: true,
        featureTipsSeenIds: ['voice-dictation', 'cmd-j-palette'],
        featureInteractions: {},
        chatUiLaunchTipVariant: 'none',
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false,
        webClient: false
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
        chatUiLaunchTipVariant: 'none',
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false,
        webClient: false
      })
    ).toEqual({ kind: 'skip' })
  })

  it('does not open after the user already interacted with the feature', () => {
    expect(
      getFeatureTipsAppOpenDecision({
        activeModal: 'none',
        cliInstalled: true,
        featureTipsSeenIds: ['cmd-j-palette'],
        chatUiLaunchTipVariant: 'none',
        featureInteractions: {
          'voice-dictation': { firstInteractedAt: 100, interactionCount: 1 }
        },
        onboarding: existingUserOnboarding,
        persistedUIReady: true,
        promptedThisSession: false,
        settings: makeSettings(),
        suppressedByOnboardingThisSession: false,
        webClient: false
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

  function decideForExistingUser(args: {
    sessionSearchEnabled: boolean
    webClient: boolean
    featureTipsSeenIds?: ('agent-session-search' | 'orca-cli')[]
    chatUiLaunchTipVariant?: ChatUiLaunchTipVariant | null
  }): ReturnType<typeof getFeatureTipsAppOpenDecision> {
    return getFeatureTipsAppOpenDecision({
      activeModal: 'none',
      cliInstalled: false,
      featureTipsSeenIds: args.featureTipsSeenIds ?? [],
      featureInteractions: {},
      chatUiLaunchTipVariant:
        args.chatUiLaunchTipVariant === undefined ? 'none' : args.chatUiLaunchTipVariant,
      onboarding: existingUserOnboarding,
      persistedUIReady: true,
      promptedThisSession: false,
      settings: makeSettings(false, args.sessionSearchEnabled),
      suppressedByOnboardingThisSession: false,
      webClient: args.webClient
    })
  }

  it('opens the session search tip first while search is off', () => {
    expect(decideForExistingUser({ sessionSearchEnabled: false, webClient: false })).toEqual({
      kind: 'open',
      tipId: 'agent-session-search'
    })
  })

  it('skips the session search tip once it has been seen', () => {
    expect(
      decideForExistingUser({
        sessionSearchEnabled: false,
        webClient: false,
        featureTipsSeenIds: ['agent-session-search']
      })
    ).toEqual({ kind: 'open', tipId: 'orca-cli' })
  })

  it('skips the session search tip when search is already on or on a web client', () => {
    expect(decideForExistingUser({ sessionSearchEnabled: true, webClient: false })).toEqual({
      kind: 'open',
      tipId: 'orca-cli'
    })
    expect(decideForExistingUser({ sessionSearchEnabled: false, webClient: true })).toEqual({
      kind: 'open',
      tipId: 'orca-cli'
    })
  })

  it('opens the Chat UI tip first only for profiles main recorded in its audience', () => {
    const decide = (variant: ChatUiLaunchTipVariant | null, webClient = false) =>
      decideForExistingUser({
        sessionSearchEnabled: true,
        webClient,
        chatUiLaunchTipVariant: variant
      })
    expect(decide('chat-ui-off')).toEqual({ kind: 'open', tipId: 'chat-ui-here' })
    expect(decide('chat-ui-on')).toEqual({ kind: 'open', tipId: 'chat-ui-here' })
    expect(decide('none')).toEqual({ kind: 'open', tipId: 'orca-cli' })
    expect(decide('chat-ui-on', true)).toEqual({ kind: 'open', tipId: 'orca-cli' })
    // Waits for main's answer rather than showing a later tip first.
    expect(decide(null)).toEqual({ kind: 'skip' })
  })

  it.each([
    ['eligible', 'chat-ui-off', 'chat-ui-off'],
    ['eligible', 'chat-ui-on', 'chat-ui-on'],
    ['excluded', 'new-profile', 'none'],
    ['excluded', 'unreadable-record', 'none'],
    ['excluded', 'chat-ui-off', 'none']
  ] as const)('maps a %s %s record to the %s variant', (membership, basis, variant) => {
    expect(chatUiLaunchTipVariant({ version: 1, membership, basis })).toBe(variant)
  })

  it('treats a profile with no session search settings as search off', () => {
    expect(isSessionSearchFeatureTipCompleted({}, false)).toBe(false)
  })
})
