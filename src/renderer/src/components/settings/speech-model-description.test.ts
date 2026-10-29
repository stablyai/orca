import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import type { SpeechModelManifest } from '../../../../shared/speech-types'
import { speechModelDescription } from './speech-model-description'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

function manifest(id: string, description: string): SpeechModelManifest {
  return {
    id,
    label: id,
    description,
    type: 'whisper',
    provider: 'local',
    language: 'multilingual',
    sampleRate: 16000,
    streaming: false
  }
}

describe('speechModelDescription', () => {
  it('translates known models by id and keeps English for models a newer main adds', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(speechModelDescription(manifest('whisper-tiny', 'English text'))).toBe(
      es.settings.voice.modelDescriptions.whisperTiny
    )
    expect(speechModelDescription(manifest('future-model', 'Future model.'))).toBe('Future model.')
  })
})
