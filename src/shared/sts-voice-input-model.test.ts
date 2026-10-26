import { describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from './constants'
import { SUPPORTED_UI_LOCALES } from './ui-locale'
import { supportsVoiceConversation } from './sts-voice-input-model'
import { localVoiceForLanguage } from './sts-voice-playback'

describe.each(SUPPORTED_UI_LOCALES)('voice language %s', (language) => {
  it('supports realtime recognition and selects a matching local playback voice', () => {
    const settings = {
      ...getDefaultVoiceSettings(),
      enabled: true,
      sttModel: 'elevenlabs-scribe-v2-realtime',
      elevenLabsApiKeyConfigured: true
    }
    expect(supportsVoiceConversation(settings, language)).toBe(true)
    const matching = { lang: `${language}-XX`, localService: true }
    expect(
      localVoiceForLanguage([{ lang: 'ko-KR', localService: false }, matching], language)
    ).toBe(matching)
    expect(
      localVoiceForLanguage([{ lang: language, localService: false }], language)
    ).toBeUndefined()
  })
})

it('rejects mismatched or batch-only recognizers and missing cloud credentials', () => {
  const settings = {
    ...getDefaultVoiceSettings(),
    enabled: true,
    sttModel: 'zipformer-streaming-en-20m'
  }
  expect(supportsVoiceConversation(settings, 'en-US')).toBe(true)
  expect(supportsVoiceConversation(settings, 'fr')).toBe(false)
  expect(supportsVoiceConversation({ ...settings, sttModel: 'whisper-tiny' }, 'en')).toBe(false)
  expect(
    supportsVoiceConversation({ ...settings, sttModel: 'elevenlabs-scribe-v2-realtime' }, 'en')
  ).toBe(false)
})

it('prefers the exact installed locale and never falls back to a different language', () => {
  const us = { lang: 'en-US', localService: true }
  const gb = { lang: 'en-GB', localService: true }
  expect(localVoiceForLanguage([us, gb], 'en-GB')).toBe(gb)
  expect(localVoiceForLanguage([us], 'ja')).toBeUndefined()
})

it('honors the selected installed voice and recovers when it is removed or the language changes', () => {
  const first = { lang: 'en-US', localService: true, voiceURI: 'first' }
  const second = { lang: 'en-GB', localService: true, voiceURI: 'second' }
  const french = { lang: 'fr-FR', localService: true, voiceURI: 'french' }
  expect(localVoiceForLanguage([first, second], 'en', 'second')).toBe(second)
  expect(localVoiceForLanguage([first], 'en', 'second')).toBe(first)
  expect(localVoiceForLanguage([first, french], 'fr', 'first')).toBe(french)
})
