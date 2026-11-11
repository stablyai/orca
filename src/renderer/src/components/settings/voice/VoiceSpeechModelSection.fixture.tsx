import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import {
  NEMOTRON_DICTATION_LANGUAGES,
  PARAKEET_V3_LANGUAGES
} from '../../../../../shared/dictation-language'
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
  local(
    'parakeet-tdt-0.6b-v3-int8',
    'Parakeet TDT v3',
    739_508_576,
    [...PARAKEET_V3_LANGUAGES],
    rates({ en: 3.7, de: 2.2 })
  ),
  local('parakeet-tdt-0.6b-v2-int8', 'Parakeet TDT v2', 729_574_912, ['en'], rates({ en: 2.8 })),
  local('zko', 'Zipformer Streaming KO', 0, ['ko'], [], 'sense-voice-zh-en-ja-ko-yue'),
  local(
    'whisper-large-v3-turbo',
    'Whisper Large v3 Turbo',
    886_381_760,
    ['en', 'ko'],
    rates({ en: 4.5, ko: 2.6 })
  ),
  local(
    'sense-voice-zh-en-ja-ko-yue',
    'SenseVoice',
    252_684_608,
    ['en', 'ko'],
    rates({ en: 6.9, ko: 10 })
  ),
  local(
    'nemotron-3.5-asr-streaming-0.6b',
    'Nemotron 3.5',
    751_094_240,
    [...NEMOTRON_DICTATION_LANGUAGES],
    rates({ en: 5.3, ko: 11.8 })
  ),
  local('whisper-tiny', 'Whisper Tiny', 45_981_088, ['en', 'ko'], rates({ en: 13, ko: 24.9 })),
  {
    id: 'openai-gpt-transcribe',
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
  ratingLanguage: string,
  setUpModelId?: string
): React.JSX.Element {
  const voiceSettings = { ...getDefaultVoiceSettings(), enabled: true, sttModel }
  return (
    <VoiceSpeechModelSection
      voiceSettings={voiceSettings}
      catalog={catalog}
      modelStates={modelStates}
      ratingLanguage={ratingLanguage}
      setUpModelId={setUpModelId}
      setUpPending={false}
      onSetUp={() => {}}
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
      'parakeet-tdt-0.6b-v3-int8',
      [
        { id: 'parakeet-tdt-0.6b-v3-int8', status: 'ready' },
        { id: 'whisper-tiny', status: 'ready' },
        { id: 'sense-voice-zh-en-ja-ko-yue', status: 'downloading', progress: 0.42 }
      ],
      'en'
    )
})

export const newUser = defineFixture({
  width: 760,
  render: () => render('', [], 'en', 'parakeet-tdt-0.6b-v2-int8')
})

export const narrow = defineFixture({
  width: 420,
  render: () =>
    render(
      'parakeet-tdt-0.6b-v3-int8',
      [{ id: 'parakeet-tdt-0.6b-v3-int8', status: 'ready' }],
      'en'
    )
})

export const korean = defineFixture({
  width: 760,
  render: () => render('', [], 'ko', 'sense-voice-zh-en-ja-ko-yue')
})

export const updateAndRetired = defineFixture({
  width: 760,
  render: () =>
    render(
      'parakeet-tdt-0.6b-v2-int8',
      [
        { id: 'parakeet-tdt-0.6b-v2-int8', status: 'not-downloaded', needsUpdate: true },
        { id: 'zko', status: 'ready' }
      ],
      'en'
    )
})
