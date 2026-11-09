import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import type { SpeechModelManifest, SpeechModelState } from '../../../../../shared/speech-types'
import { VoiceSetupCard } from './VoiceSetupCard'

const parakeet: SpeechModelManifest = {
  id: 'v3',
  label: 'Parakeet TDT v3',
  type: 'transducer',
  provider: 'local',
  language: 'multilingual',
  languages: ['en'],
  sizeBytes: 739_508_576,
  sampleRate: 16000,
  streaming: false
}

function render(
  enabled: boolean,
  model: SpeechModelManifest | undefined,
  state: SpeechModelState | undefined
): React.JSX.Element {
  return (
    <VoiceSetupCard
      voiceSettings={{ ...getDefaultVoiceSettings(), enabled, sttModel: model?.id ?? '' }}
      selectedModel={model}
      selectedState={state}
      permissionPending={false}
      onToggleVoiceDictation={() => {}}
      onDownloadModel={() => {}}
      onCancelDownload={() => {}}
      onShowMicrophone={() => {}}
    />
  )
}

export const newUser = defineFixture({
  width: 760,
  render: () => render(false, undefined, undefined)
})

export const on = defineFixture({
  width: 760,
  render: () => render(true, parakeet, { id: 'v3', status: 'ready' })
})

export const off = defineFixture({
  width: 760,
  render: () => render(false, parakeet, { id: 'v3', status: 'ready' })
})

export const needsUpdate = defineFixture({
  width: 760,
  render: () => render(true, parakeet, { id: 'v3', status: 'not-downloaded', needsUpdate: true })
})

export const downloading = defineFixture({
  width: 760,
  render: () => render(true, parakeet, { id: 'v3', status: 'downloading', progress: 0.42 })
})
