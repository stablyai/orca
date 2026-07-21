import { describe, expect, it } from 'vitest'
import { encodeRecoveryAudioWav, getRecoverableDictationText } from './dictation-recovery'

describe('dictation recovery', () => {
  it('combines inserted final text with the visible partial transcript', () => {
    expect(getRecoverableDictationText('hello', 'world')).toBe('hello world')
  })

  it('encodes recovery audio chunks as a wav file', () => {
    const wav = encodeRecoveryAudioWav([
      { samples: new Float32Array([0, 1, -1]), sampleRate: 16_000, sessionId: 's1' }
    ])

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE')
    expect(wav.byteLength).toBe(44 + 3 * 2)
  })
})
