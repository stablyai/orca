// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import type { SpeechModelManifest } from '../../../../../shared/speech-types'
import { VoiceDictationLanguageSetting } from './VoiceDictationLanguageSetting'

afterEach(cleanup)

it('searches and updates the selected dictation language', () => {
  const onUpdateVoiceSettings = vi.fn()
  render(
    <VoiceDictationLanguageSetting
      voiceSettings={{
        ...getDefaultVoiceSettings(),
        enabled: true,
        dictationLanguage: 'ko'
      }}
      selectedModel={undefined}
      onUpdateVoiceSettings={onUpdateVoiceSettings}
    />
  )

  fireEvent.click(screen.getByRole('combobox', { name: /dictation language/i }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Search languages…' }), {
    target: { value: 'spanish' }
  })
  fireEvent.click(screen.getByRole('option', { name: 'Spanish' }))

  expect(onUpdateVoiceSettings).toHaveBeenCalledWith({ dictationLanguage: 'es' })
})

it('keeps a selected language visible when the chosen model does not support it', () => {
  const selectedModel: SpeechModelManifest = {
    id: 'limited',
    label: 'Limited model',
    type: 'whisper',
    provider: 'local',
    language: 'multilingual',
    languages: ['en', 'es'],
    sampleRate: 16000,
    streaming: false,
    dictationLanguages: ['en', 'es']
  }
  render(
    <VoiceDictationLanguageSetting
      voiceSettings={{
        ...getDefaultVoiceSettings(),
        enabled: true,
        dictationLanguage: 'ko'
      }}
      selectedModel={selectedModel}
      onUpdateVoiceSettings={vi.fn()}
    />
  )

  fireEvent.click(screen.getByRole('combobox', { name: /dictation language/i }))
  expect(screen.getByRole('option', { name: 'Korean' })).toBeTruthy()
})
