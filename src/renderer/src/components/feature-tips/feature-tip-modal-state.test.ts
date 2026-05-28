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
      modalData: { tipId: 'voice-dictation' },
      seenTipIds: ['voice-dictation'],
      settings: makeSettings()
    })

    expect(tip?.id).toBe('voice-dictation')
  })

  it('falls back to the next unseen tip when no modal tip id is pinned', () => {
    const tip = getFeatureTipForModal({
      modalData: {},
      seenTipIds: [],
      settings: makeSettings()
    })

    expect(tip?.id).toBe('voice-dictation')
  })

  it('returns no tip when every tip is already seen and no modal tip id is pinned', () => {
    const tip = getFeatureTipForModal({
      modalData: {},
      seenTipIds: ['voice-dictation', 'agent-status-sidebar'],
      settings: makeSettings()
    })

    expect(tip).toBeNull()
  })
})
