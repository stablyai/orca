import { describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from './constants'

describe('voice settings defaults', () => {
  it('keeps system audio muting opt-in', () => {
    expect(getDefaultVoiceSettings().muteSystemAudioDuringDictation).toBe(false)
  })
})
