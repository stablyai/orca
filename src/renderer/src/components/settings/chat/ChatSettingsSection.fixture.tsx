import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import { ChatSettingsSection } from './ChatSettingsSection'
import { ActiveSettingsSectionProvider } from '../section-layout/SettingsSection'
import { LOCAL_SETTINGS_HOST_SCOPE } from '../host-scope/settings-host-scope'

function ChatSettingsPreview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return settings ? (
    <ActiveSettingsSectionProvider value="chat">
      <ChatSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        writeSourceControlAiSettings={async () => {}}
        searchEntries={[]}
        showDesktopOnlySettings
        hostScope={LOCAL_SETTINGS_HOST_SCOPE}
        isMounted
      />
    </ActiveSettingsSectionProvider>
  ) : null
}

export const desktop = defineFixture({ width: 820, render: () => <ChatSettingsPreview /> })
export const narrow = defineFixture({ width: 390, render: () => <ChatSettingsPreview /> })
