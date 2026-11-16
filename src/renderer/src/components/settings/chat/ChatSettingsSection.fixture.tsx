import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import { ChatSettingsSection } from './ChatSettingsSection'
import { getChatBehaviorSearchEntries } from './chat-behavior-search'
import { ActiveSettingsSectionProvider } from '../section-layout/SettingsSection'

function ChatSettingsPreview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return settings ? (
    <ActiveSettingsSectionProvider value="chat">
      <ChatSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        writeSourceControlAiSettings={async () => {}}
        searchEntries={getChatBehaviorSearchEntries()}
        showDesktopOnlySettings
        isMounted
      />
    </ActiveSettingsSectionProvider>
  ) : null
}

export const desktop = defineFixture({ width: 820, render: () => <ChatSettingsPreview /> })
export const narrow = defineFixture({ width: 390, render: () => <ChatSettingsPreview /> })
export const autoExpandToolsOff = defineFixture({
  width: 820,
  store: { settingsSearchQuery: 'Auto expand tools' },
  render: () => <ChatSettingsPreview />
})
export const autoExpandTools = defineFixture({
  store: { settingsSearchQuery: 'Auto expand tools' },
  width: 820,
  setup: () => {
    const settings = useAppStore.getState().settings
    if (settings) {
      useAppStore.setState({ settings: { ...settings, nativeChatAutoExpandTools: true } })
    }
  },
  render: () => <ChatSettingsPreview />
})
