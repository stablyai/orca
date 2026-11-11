import { describe, expect, it } from 'vitest'
import { suggestSpeechModel } from './speech-model-suggestion'
import type { SpeechModelErrorRate, SpeechModelManifest } from './speech-types'

const rate = (language: string, percent: number): SpeechModelErrorRate => ({
  language,
  percent,
  metric: 'wer',
  test: 'fleurs',
  clips: 5,
  measuredOn: '2026-11-09'
})

const model = (id: string, extra: Partial<SpeechModelManifest>): SpeechModelManifest => ({
  id,
  label: id,
  type: 'transducer',
  provider: 'local',
  language: 'multilingual',
  languages: [],
  sampleRate: 16000,
  streaming: false,
  ...extra
})

const catalog = [
  model('parakeet', { recommended: true, languages: ['en', 'fr'], errorRates: [rate('fr', 8)] }),
  model('sense', { languages: ['en', 'ko'], suggestedFor: ['ko'], errorRates: [rate('ko', 10)] }),
  model('nemotron', { languages: ['fr', 'ko', 'tr'], errorRates: [rate('tr', 14)] }),
  model('turbo', {
    languages: ['fr', 'ko', 'tr', 'cy'],
    errorRates: [rate('fr', 5), rate('ko', 3), rate('tr', 8)]
  }),
  model('retired', { languages: ['tr'], errorRates: [rate('tr', 1)], replacedBy: 'turbo' })
]

describe('suggestSpeechModel', () => {
  it('keeps the user’s own pick while it is offered', () => {
    const pick = (selectedModelId: string) =>
      suggestSpeechModel(catalog, 'tr', { selectedModelId, favorAccuracy: false })?.id
    expect(pick('nemotron')).toBe('nemotron')
    expect(pick('retired')).toBe('turbo')
  })
})
