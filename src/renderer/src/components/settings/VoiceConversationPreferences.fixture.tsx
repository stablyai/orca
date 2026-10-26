import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings, getDefaultVoiceSettings } from '../../../../shared/constants'
import { VoiceConversationPreferences } from './VoiceConversationPreferences'

function Preferences(): React.JSX.Element {
  const [settings, setSettings] = useState(getDefaultVoiceSettings)
  return (
    <VoiceConversationPreferences
      settings={settings}
      uiLanguage="en"
      onUpdate={(updates) => setSettings((current) => ({ ...current, ...updates }))}
    />
  )
}

export const installation = defineFixture({
  width: 580,
  store: { settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en' } },
  setup: () => {
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined })
  },
  render: () => (
    <div className="p-4">
      <Preferences />
    </div>
  )
})

export const narrow = defineFixture({ ...installation, width: 320 })
