import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import type {
  SpeechModelErrorRate,
  SpeechModelManifest,
  SpeechModelState
} from '../../../../../shared/speech-types'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'

const rates = (entries: Record<string, number>): SpeechModelErrorRate[] =>
  Object.entries(entries).map(([language, percent]) => ({
    language,
    percent,
    metric: ['ja', 'ko', 'zh'].includes(language) ? 'cer' : 'wer',
    test: language === 'en' ? 'librispeech' : 'fleurs',
    clips: language === 'en' ? 73 : 5,
    measuredOn: '2026-11-09'
  }))

function local(
  id: string,
  label: string,
  sizeBytes: number,
  languages: string[],
  errorRates: SpeechModelErrorRate[],
  replacedBy?: string
): SpeechModelManifest {
  return {
    id,
    label,
    type: 'transducer',
    provider: 'local',
    language: 'multilingual',
    languages,
    errorRates,
    sizeBytes,
    sampleRate: 16000,
    streaming: false,
    replacedBy
  }
}

const catalog: SpeechModelManifest[] = [
  local('v3', 'Parakeet TDT v3', 739_508_576, ['en', 'de'], rates({ en: 3.7, de: 2.2 })),
  local('v2', 'Parakeet TDT v2', 729_574_912, ['en'], rates({ en: 2.8 })),
  local('zko', 'Zipformer Streaming KO', 0, ['ko'], [], 'sense'),
  local('turbo', 'Whisper Large v3 Turbo', 886_381_760, ['en', 'ko'], rates({ en: 4.5, ko: 2.6 })),
  local('sense', 'SenseVoice', 252_684_608, ['en', 'ko'], rates({ en: 6.9, ko: 10 })),
  local('nemotron', 'Nemotron 3.5', 751_094_240, ['en', 'ko'], rates({ en: 5.3, ko: 11.8 })),
  local('tiny', 'Whisper Tiny', 45_981_088, ['en', 'ko'], rates({ en: 13, ko: 24.9 })),
  {
    id: 'gpt',
    label: 'GPT Transcribe',
    type: 'openai',
    provider: 'openai',
    language: 'multilingual',
    languages: ['en', 'ko'],
    sampleRate: 16000,
    streaming: false
  }
]

function render(
  sttModel: string,
  modelStates: SpeechModelState[],
  ratingLanguage: string
): React.JSX.Element {
  return (
    <VoiceSpeechModelSection
      voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true, sttModel }}
      catalog={catalog}
      modelStates={modelStates}
      ratingLanguage={ratingLanguage}
      onUpdateVoiceSettings={() => {}}
      onOpenCloudSetup={() => {}}
      onRefreshModelStates={() => {}}
      cloudSettings={null}
    />
  )
}

export const english = defineFixture({
  width: 760,
  render: () =>
    render(
      'v3',
      [
        { id: 'v3', status: 'ready' },
        { id: 'tiny', status: 'ready' },
        { id: 'sense', status: 'downloading', progress: 0.42 }
      ],
      'en'
    )
})

export const korean = defineFixture({
  width: 760,
  render: () => render('', [], 'ko')
})

export const updateAndRetired = defineFixture({
  width: 760,
  render: () =>
    render(
      'v2',
      [
        { id: 'v2', status: 'not-downloaded', needsUpdate: true },
        { id: 'zko', status: 'ready' }
      ],
      'en'
    )
})
