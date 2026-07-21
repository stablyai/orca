import { describe, expect, it } from 'vitest'
import { normalizeDictationOutputSettings } from './dictation-output-settings'

describe('normalizeDictationOutputSettings', () => {
  it('clamps ducking percent into the supported range', () => {
    expect(normalizeDictationOutputSettings({ duckedVolumePercent: -5 }).duckedVolumePercent).toBe(
      0
    )
    expect(normalizeDictationOutputSettings({ duckedVolumePercent: 140 }).duckedVolumePercent).toBe(
      100
    )
  })

  it('defaults unknown volume modes to unchanged', () => {
    expect(normalizeDictationOutputSettings({ outputVolumeMode: 'loud' }).outputVolumeMode).toBe(
      'unchanged'
    )
  })

  it('preserves pause media only when it is a strict boolean', () => {
    expect(
      normalizeDictationOutputSettings({ pauseMediaOnDictation: true }).pauseMediaOnDictation
    ).toBe(true)
    expect(
      normalizeDictationOutputSettings({ pauseMediaOnDictation: 'true' }).pauseMediaOnDictation
    ).toBe(false)
  })
})
