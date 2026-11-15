import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import { VoiceSpeechGpuSetting } from './VoiceSpeechGpuSetting'

export const auto = defineFixture({
  width: 640,
  render: () => (
    <VoiceSpeechGpuSetting
      voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true }}
      onUpdateVoiceSettings={() => {}}
    />
  )
})

export const off = defineFixture({
  width: 640,
  render: () => (
    <VoiceSpeechGpuSetting
      voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true, speechGpu: 'off' }}
      onUpdateVoiceSettings={() => {}}
    />
  )
})
