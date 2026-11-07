import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import type { SpeechModelManifest } from '../../../../../shared/speech-types'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'

function model(id: string, label: string, sizeBytes: number, description: string) {
  return {
    id,
    label,
    description,
    type: 'transducer',
    provider: 'local',
    language: 'en',
    sizeBytes,
    sampleRate: 16000,
    streaming: false
  } satisfies SpeechModelManifest
}

const catalog = [
  model('v3', 'Parakeet TDT v3', 739_508_576, 'Highest accuracy for 25 European languages.'),
  model(
    'v2',
    'Parakeet TDT v2',
    729_574_912,
    'English only. Faster than v3 with similar accuracy.'
  ),
  model(
    'nemotron',
    'Nemotron 3.5',
    751_094_240,
    '28 languages including Korean, Chinese and Japanese.'
  )
]

export const updateAvailable = defineFixture({
  width: 640,
  render: () => (
    <VoiceSpeechModelSection
      voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true, sttModel: 'v2' }}
      catalog={catalog}
      modelStates={[
        { id: 'v3', status: 'ready' },
        { id: 'v2', status: 'not-downloaded', needsUpdate: true },
        { id: 'nemotron', status: 'not-downloaded' }
      ]}
      onUpdateVoiceSettings={() => {}}
      onOpenOpenAiDialog={() => {}}
      onRefreshModelStates={() => {}}
    />
  ),
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button')
      ?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
  }
})
