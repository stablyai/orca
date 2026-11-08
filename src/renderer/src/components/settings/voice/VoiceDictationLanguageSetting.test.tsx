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

  fireEvent.click(screen.getByRole('combobox', { name: 'Dictation Language' }))
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
    description: '',
    type: 'whisper',
    provider: 'local',
    language: 'multilingual',
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

  fireEvent.click(screen.getByRole('combobox', { name: 'Dictation Language' }))
  expect(screen.getByRole('option', { name: 'Korean' })).toBeTruthy()
})

it('keeps the language control disabled for models that ignore language settings', () => {
  const selectedModel: SpeechModelManifest = {
    id: 'parakeet',
    label: 'Parakeet',
    description: '',
    type: 'transducer',
    provider: 'local',
    language: 'multilingual',
    sampleRate: 16000,
    streaming: false
  }
  render(
    <VoiceDictationLanguageSetting
      voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true }}
      selectedModel={selectedModel}
      onUpdateVoiceSettings={vi.fn()}
    />
  )

  const trigger = screen.getByRole('combobox', { name: 'Dictation Language' })
  expect(trigger.getAttribute('disabled')).not.toBeNull()
})
