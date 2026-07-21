import { describe, expect, it } from 'vitest'
import { getMicrophoneDeviceLabel, getMicrophoneSelectDevices } from './VoiceMicrophoneSection'

describe('getMicrophoneDeviceLabel', () => {
  it('falls back to a numbered microphone label when the browser hides labels', () => {
    expect(getMicrophoneDeviceLabel({ label: '', index: 1 })).toBe('Microphone 2')
  })

  it('keeps a stale selected microphone visible so users can switch away', () => {
    expect(getMicrophoneSelectDevices([], 'missing-mic')).toEqual([
      { deviceId: 'missing-mic', label: 'Unavailable microphone', unavailable: true }
    ])
  })
})
