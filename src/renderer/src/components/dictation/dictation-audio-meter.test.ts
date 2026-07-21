import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DICTATION_METER,
  analyzeDictationAudioChunk,
  createDictationMeterAnalyzerState,
  measureDictationAudioChunk,
  resetDictationMeterState,
  truncateDictationTranscript
} from './dictation-audio-meter'

describe('dictation audio meter', () => {
  it('measures RMS, peak, and clipping for a mixed chunk', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])

    const measurement = measureDictationAudioChunk(samples)
    const state = analyzeDictationAudioChunk(samples, 100, createDictationMeterAnalyzerState())

    expect(measurement.rms).toBeCloseTo(0.70710678, 8)
    expect(measurement.peak).toBe(1)
    expect(state.isClipping).toBe(true)
  })

  it('returns zero RMS and peak for an empty chunk', () => {
    expect(measureDictationAudioChunk(new Float32Array())).toEqual({ rms: 0, peak: 0 })
  })

  it('keeps zero chunks silent after the silence threshold', () => {
    let state = createDictationMeterAnalyzerState()

    state = analyzeDictationAudioChunk(new Float32Array([0, 0, 0]), 0, state)
    state = analyzeDictationAudioChunk(new Float32Array([0, 0, 0]), 1_001, state)

    expect(state.isSilent).toBe(true)
    expect(state.isSpeaking).toBe(false)
  })

  it('detects normal speech above the adaptive noise floor', () => {
    const state = analyzeDictationAudioChunk(
      new Float32Array([0.2, -0.2, 0.18, -0.18]),
      100,
      createDictationMeterAnalyzerState()
    )

    expect(state.isSpeaking).toBe(true)
    expect(state.isSilent).toBe(false)
    expect(state.level).toBeGreaterThan(0)
  })

  it('resets to the public default meter state', () => {
    expect(resetDictationMeterState()).toEqual(DEFAULT_DICTATION_METER)
  })

  it('keeps the tail and drops the oldest prefix of long transcripts', () => {
    const oldestPrefix = 'OLDEST_PREFIX_DROPPED '
    const newestPhrase = 'newest words stay visible'
    const text = `${oldestPrefix}${'filler '.repeat(10)}${newestPhrase}`

    const truncated = truncateDictationTranscript(text)

    expect(truncated).toHaveLength(80)
    expect(truncated.startsWith('…')).toBe(true)
    expect(truncated).not.toContain(oldestPrefix)
    expect(truncated.endsWith(newestPhrase)).toBe(true)
  })
})
