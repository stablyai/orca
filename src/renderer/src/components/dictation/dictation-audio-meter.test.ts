import { describe, expect, it } from 'vitest'
import {
  analyzeDictationAudioChunk,
  createDictationMeterAnalyzerState,
  measureDictationAudioChunk,
  toPublicDictationMeterState
} from './dictation-audio-meter'

describe('dictation audio meter', () => {
  it('measures RMS and clamps peaks from copied audio samples', () => {
    expect(measureDictationAudioChunk(new Float32Array([0.5, -0.5]))).toEqual({
      rms: 0.5,
      peak: 0.5
    })
    expect(measureDictationAudioChunk(new Float32Array([2]))).toEqual({ rms: 2, peak: 1 })
  })

  it('uses a fast attack and slower release for a stable voice envelope', () => {
    const initial = createDictationMeterAnalyzerState()
    const loud = analyzeDictationAudioChunk(new Float32Array(128).fill(0.3), 100, initial)
    const quiet = analyzeDictationAudioChunk(new Float32Array(128), 200, loud)

    expect(loud.level).toBeGreaterThan(0.5)
    expect(loud.isSpeaking).toBe(true)
    expect(quiet.level).toBeGreaterThan(0.3)
    expect(quiet.level).toBeLessThan(loud.level)
  })

  it('holds clipping briefly so a single peak does not flicker', () => {
    const initial = createDictationMeterAnalyzerState()
    const clipped = analyzeDictationAudioChunk(new Float32Array([1]), 1_000, initial)
    const held = analyzeDictationAudioChunk(new Float32Array([0]), 1_400, clipped)
    const released = analyzeDictationAudioChunk(new Float32Array([0]), 1_600, held)

    expect(clipped.isClipping).toBe(true)
    expect(held.isClipping).toBe(true)
    expect(released.isClipping).toBe(false)
  })

  it('publishes only presentation-safe meter fields', () => {
    const analyzed = analyzeDictationAudioChunk(
      new Float32Array(128).fill(0.25),
      250,
      createDictationMeterAnalyzerState()
    )

    expect(toPublicDictationMeterState(analyzed)).toEqual({
      level: Math.round(analyzed.level * 100) / 100,
      isSpeaking: analyzed.isSpeaking,
      isClipping: analyzed.isClipping
    })
  })
})
