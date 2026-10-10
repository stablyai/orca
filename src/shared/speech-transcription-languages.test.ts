import { describe, expect, it } from 'vitest'
import {
  getModelTranscriptionLanguages,
  resolveModelLanguageHint
} from './speech-transcription-languages'

describe('model transcription languages', () => {
  it('reports no picker languages for a model that picks its own', () => {
    expect(getModelTranscriptionLanguages(undefined)).toBeNull()
  })

  it('keeps only picker codes from a provider subset and drops auto', () => {
    expect(getModelTranscriptionLanguages(['de', 'en', 'xx'])).toEqual(['en', 'de'])
    expect(getModelTranscriptionLanguages('any')).not.toContain('auto')
    expect(getModelTranscriptionLanguages('any')).toContain('uk')
  })

  it('sends a hint only when the model honours it', () => {
    expect(resolveModelLanguageHint('any', 'uk')).toBe('uk')
    expect(resolveModelLanguageHint(['en', 'de'], 'uk')).toBeUndefined()
    expect(resolveModelLanguageHint(['en', 'de'], 'de')).toBe('de')
    expect(resolveModelLanguageHint(undefined, 'uk')).toBeUndefined()
    expect(resolveModelLanguageHint('any', 'auto')).toBeUndefined()
  })
})
