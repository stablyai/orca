import { describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getFeatureTipForModal } from './feature-tip-modal-state'

// Session search defaults on so tests about the older tips don't see the session-search tip first.
function makeSettings(
  voiceEnabled = false,
  sessionSearchEnabled = true,
  nativeChatGraduationCohort?: GlobalSettings['nativeChatGraduationCohort']
): Pick<GlobalSettings, 'voice' | 'aiVaultSearch' | 'nativeChatGraduationCohort'> {
  return {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: voiceEnabled
    },
    aiVaultSearch: { enabled: sessionSearchEnabled, historyDays: null },
    nativeChatGraduationCohort
  }
}

describe('feature tip modal state', () => {
  it('keeps rendering the opened tip after app open has marked it seen', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: { tipId: 'voice-dictation' },
      seenTipIds: ['voice-dictation'],
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('voice-dictation')
  })

  it('falls back to the CLI tip first when no modal tip id is pinned', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: [],
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('orca-cli')
  })

  it('falls back to the CLI tip when voice was already seen and the CLI is not installed', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: ['voice-dictation'],
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('orca-cli')
  })

  it('falls back to the command palette tip after the CLI tip is handled', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: {},
      seenTipIds: ['orca-cli'],
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('cmd-j-palette')
  })

  it('returns no tip when every tip is already seen and no modal tip id is pinned', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: ['voice-dictation', 'orca-cli', 'cmd-j-palette'],
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip).toBeNull()
  })

  it('returns no CLI tip when the CLI is already installed', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: {},
      seenTipIds: ['voice-dictation', 'cmd-j-palette'],
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip).toBeNull()
  })

  it('returns no unpinned tip after the user already interacted with the feature', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: {},
      seenTipIds: ['cmd-j-palette'],
      featureInteractions: {
        'voice-dictation': { firstInteractedAt: 100, interactionCount: 1 }
      },
      settings: makeSettings(),
      webClient: false
    })

    expect(tip).toBeNull()
  })

  it('never opens the native chat upgrade tip by id outside the opt-in cohort', () => {
    for (const cohort of [undefined, 'other'] as const) {
      const tip = getFeatureTipForModal({
        cliInstalled: true,
        modalData: { tipId: 'native-chat-upgrade' },
        seenTipIds: [],
        featureInteractions: {},
        settings: makeSettings(false, true, cohort),
        webClient: false
      })
      expect(tip).toBeNull()
    }
  })

  it('keeps rendering the native chat upgrade tip for the opt-in cohort after it was marked seen', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: { tipId: 'native-chat-upgrade' },
      seenTipIds: ['native-chat-upgrade'],
      featureInteractions: {},
      settings: makeSettings(false, true, 'experimental-opt-in'),
      webClient: false
    })

    expect(tip?.id).toBe('native-chat-upgrade')
  })

  it('cycles to the native chat upgrade tip only for the opt-in cohort', () => {
    const args = {
      cliInstalled: true,
      modalData: {},
      seenTipIds: [],
      featureInteractions: {},
      webClient: false
    }
    expect(
      getFeatureTipForModal({ ...args, settings: makeSettings(false, true, 'experimental-opt-in') })
        ?.id
    ).toBe('native-chat-upgrade')
    expect(
      getFeatureTipForModal({ ...args, settings: makeSettings(false, true, 'other') })?.id
    ).not.toBe('native-chat-upgrade')
  })
})
