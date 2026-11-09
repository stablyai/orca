import { describe, expect, it } from 'vitest'
import { speechModelQuality, speechModelRatingLanguage } from './speech-model-quality'
import type { SpeechModelErrorRate } from './speech-types'

const rate = (language: string, percent: number): SpeechModelErrorRate => ({
  language,
  percent,
  metric: 'wer',
  test: 'fleurs',
  clips: 5,
  measuredOn: '2026-11-09'
})

describe('speechModelQuality', () => {
  it('rates by the approved word scale, inclusive at each ceiling', () => {
    const tiers = [3, 3.1, 6, 10, 20, 20.1].map((percent) => {
      const quality = speechModelQuality(
        { languages: ['de'], errorRates: [rate('de', percent)] },
        'de'
      )
      return quality.kind === 'rated' ? quality.tier : quality.kind
    })
    expect(tiers).toEqual([5, 4, 4, 3, 2, 1])
  })

  it('tells an unsupported language from a supported one nobody measured', () => {
    const model = { languages: ['en', 'fr'], errorRates: [rate('en', 4)] }
    expect(speechModelQuality(model, 'ko').kind).toBe('unsupported')
    expect(speechModelQuality(model, 'fr').kind).toBe('unmeasured')
  })
})

describe('speechModelRatingLanguage', () => {
  it('uses the dictation language, else the system locale’s language', () => {
    expect(speechModelRatingLanguage('de', 'ja-JP')).toBe('de')
    expect(speechModelRatingLanguage('auto', 'zh-Hant-TW')).toBe('zh')
    expect(speechModelRatingLanguage('auto', 'pt_BR')).toBe('pt')
    expect(speechModelRatingLanguage('auto', undefined)).toBeUndefined()
  })
})
