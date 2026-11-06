import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import {
  DICTATION_LANGUAGES,
  SENSE_VOICE_DICTATION_LANGUAGES
} from '../../../../../shared/dictation-language'
import type { SpeechModelManifest, SpeechModelType } from '../../../../../shared/speech-types'
import { VoiceDictationLanguageSetting } from './VoiceDictationLanguageSetting'

function model(
  label: string,
  type: SpeechModelType,
  dictationLanguages?: readonly string[]
): SpeechModelManifest {
  return {
    id: label,
    label,
    description: '',
    type,
    provider: 'local',
    language: 'multilingual',
    sampleRate: 16000,
    streaming: false,
    dictationLanguages
  }
}

function render(
  dictationLanguage: string,
  selectedModel: SpeechModelManifest | undefined
): () => React.JSX.Element {
  return () => (
    <VoiceDictationLanguageSetting
      voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true, dictationLanguage }}
      selectedModel={selectedModel}
      onUpdateVoiceSettings={() => {}}
    />
  )
}

export const whisperKorean = defineFixture({
  width: 640,
  render: render('ko', model('Whisper Tiny', 'whisper', DICTATION_LANGUAGES))
})

export const whisperMenu = defineFixture({
  ...whisperKorean,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[role="combobox"]')?.click()
  }
})

export const senseVoiceFrench = defineFixture({
  width: 640,
  render: render('fr', model('SenseVoice', 'senseVoice', SENSE_VOICE_DICTATION_LANGUAGES))
})

export const parakeetIgnores = defineFixture({
  width: 640,
  render: render('ko', model('Parakeet TDT v3', 'transducer'))
})
