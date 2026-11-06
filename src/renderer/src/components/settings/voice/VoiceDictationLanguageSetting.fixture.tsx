import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import type { SpeechModelManifest, SpeechModelType } from '../../../../../shared/speech-types'
import { VoiceDictationLanguageSetting } from './VoiceDictationLanguageSetting'

function model(label: string, type: SpeechModelType): SpeechModelManifest {
  return {
    id: label,
    label,
    description: '',
    type,
    provider: 'local',
    language: 'multilingual',
    sampleRate: 16000,
    streaming: false
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
  render: render('ko', model('Whisper Tiny', 'whisper'))
})

export const whisperMenu = defineFixture({
  ...whisperKorean,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[role="combobox"]')?.click()
  }
})

export const senseVoiceFrench = defineFixture({
  width: 640,
  render: render('fr', model('SenseVoice', 'senseVoice'))
})

export const parakeetIgnores = defineFixture({
  width: 640,
  render: render('ko', model('Parakeet TDT v3', 'transducer'))
})
