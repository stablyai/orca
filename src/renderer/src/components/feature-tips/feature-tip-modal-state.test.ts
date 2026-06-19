import { describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { getFeatureTipForModal } from './feature-tip-modal-state'

function makeSettings(voiceEnabled = false): Pick<GlobalSettings, 'voice'> {
  return {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: voiceEnabled
    }
  }
}

describe('feature tip modal state', () => {
  it('keeps rendering the opened tip after app open has marked it seen', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: { tipId: 'voice-dictation' },
      seenTipIds: ['voice-dictation'],
      featureInteractions: {},
      settings: makeSettings()
    })

    expect(tip?.id).toBe('voice-dictation')
  })

  it('falls back to the CLI tip first when no modal tip id is pinned', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: [],
      featureInteractions: {},
      settings: makeSettings()
    })

    expect(tip?.id).toBe('orca-cli')
  })

  it('falls back to the CLI tip when voice was already seen and the CLI is not installed', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: ['voice-dictation'],
      featureInteractions: {},
      settings: makeSettings()
    })

    expect(tip?.id).toBe('orca-cli')
  })

  it('falls back to the command palette tip after the CLI tip is handled', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: {},
      seenTipIds: ['orca-cli'],
      featureInteractions: {},
      settings: makeSettings()
    })

    expect(tip?.id).toBe('cmd-j-palette')
  })

  it('returns no tip when every tip is already seen and no modal tip id is pinned', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: false,
      modalData: {},
      seenTipIds: ['voice-dictation', 'orca-cli', 'cmd-j-palette'],
      featureInteractions: {},
      settings: makeSettings()
    })

    expect(tip).toBeNull()
  })

  it('returns no CLI tip when the CLI is already installed', () => {
    const tip = getFeatureTipForModal({
      cliInstalled: true,
      modalData: {},
      seenTipIds: ['voice-dictation', 'cmd-j-palette'],
      featureInteractions: {},
      settings: makeSettings()
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
      settings: makeSettings()
    })

    expect(tip).toBeNull()
  })
})
