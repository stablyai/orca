import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { ChatNamingSetting } from './ChatNamingSetting'

function ChatNamingPreview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return settings ? (
    <ChatNamingSetting
      settings={settings}
      updateSettings={updateSettings}
      writeSourceControlAiSettings={async () => {}}
      forceVisible
    />
  ) : null
}

const withSettings = (settings: Partial<GlobalSettings>) => ({
  settings: { ...getDefaultSettings('/home/fixture'), ...settings }
})

export const off = defineFixture({ width: 720, render: () => <ChatNamingPreview /> })
export const on = defineFixture({
  width: 720,
  store: withSettings({ antigravityChatNaming: true }),
  render: () => <ChatNamingPreview />
})
export const apiKey = defineFixture({
  width: 390,
  store: withSettings({ antigravityChatAuth: { method: 'gemini-api-key' } }),
  render: () => <ChatNamingPreview />
})
