import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/orca-profiles/constants'
import {
  NEMOTRON_DICTATION_LANGUAGES,
  PARAKEET_V3_LANGUAGES
} from '../../../../../shared/speech/models/dictation-language'
import type {
  SpeechModelErrorRate,
  SpeechModelManifest,
  SpeechModelState
} from '../../../../../shared/speech/speech-types'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'
import { VoiceChatGptAccountSetting } from './VoiceChatGptAccountSetting'

function SubscriptionAccountFixture({
  initialId
}: {
  initialId: string | null
}): React.JSX.Element {
  const [accountId, setAccountId] = useState(initialId)
  return (
    <VoiceChatGptAccountSetting
      accountId={accountId}
      accounts={[
        { id: 'dictation-personal', label: 'Personal (voice@example.test)' },
        { id: 'dictation-work', label: 'Work (work@example.test)' }
      ]}
      onChange={setAccountId}
      onManage={() => {}}
    />
  )
}

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
  },
  {
    id: 'chatgpt-subscription-transcribe',
    label: 'ChatGPT subscription',
    type: 'chatgpt',
    provider: 'chatgpt',
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
  setUpModelId?: string,
  chatGptAccountId: string | null = null
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
      cloudSettings={
        sttModel === 'chatgpt-subscription-transcribe' ? (
          <SubscriptionAccountFixture initialId={chatGptAccountId} />
        ) : null
      }
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

export const subscriptionReady = defineFixture({
  width: 760,
  render: () =>
    render(
      'chatgpt-subscription-transcribe',
      [{ id: 'chatgpt-subscription-transcribe', status: 'ready' }],
      'en',
      undefined,
      'dictation-personal'
    )
})

export const subscriptionLoginRequired = defineFixture({
  width: 760,
  render: () =>
    render(
      'chatgpt-subscription-transcribe',
      [{ id: 'chatgpt-subscription-transcribe', status: 'not-downloaded' }],
      'en'
    )
})

export const subscriptionRemovedAccount = defineFixture({
  width: 760,
  render: () =>
    render(
      'chatgpt-subscription-transcribe',
      [{ id: 'chatgpt-subscription-transcribe', status: 'not-downloaded' }],
      'en',
      undefined,
      'removed-account'
    )
})

export const subscriptionNarrow = defineFixture({ ...subscriptionReady, width: 420 })

export const subscriptionAccountMenu = defineFixture({
  ...subscriptionReady,
  interact: (frame) => {
    const trigger = frame.querySelector<HTMLElement>('[role="combobox"][aria-labelledby]')
    if (!trigger) {
      throw new Error('ChatGPT account selector is missing')
    }
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  }
})
