import { describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getFeatureTipForModal } from './feature-tip-modal-state'

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

describe('feature tip modal state', () => {
  it('keeps rendering the opened tip after app open has marked it seen', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: { tipId: 'voice-dictation' },
      seenTipIds: ['voice-dictation'],
      inNativeChatUpgradeTipAudience: false,
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
      inNativeChatUpgradeTipAudience: false,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('orca-cli')
  })

  it('refuses the native chat upgrade tip by id for any profile outside its audience', () => {
    for (const inNativeChatUpgradeTipAudience of [false, null]) {
      expect(
        getFeatureTipForModal({
          cliInstalled: true,
          modalData: { tipId: 'native-chat-upgrade' },
          seenTipIds: [],
          inNativeChatUpgradeTipAudience,
          featureInteractions: {},
          settings: makeSettings(),
          webClient: false
        })
      ).toBeNull()
    }
  })

  it('renders the native chat upgrade tip by id for its audience', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: { tipId: 'native-chat-upgrade' },
      seenTipIds: ['native-chat-upgrade'],
      inNativeChatUpgradeTipAudience: true,
      featureInteractions: {},
      settings: makeSettings(),
      webClient: false
    })

    expect(tip?.id).toBe('native-chat-upgrade')
  })
})
