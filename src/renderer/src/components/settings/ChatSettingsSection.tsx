import { translate } from '@/i18n/i18n'
import { AppearanceChatSection } from './AppearanceChatSection'
import { SettingsSection } from './SettingsSection'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'

export function ChatSettingsSection({
  settings,
  updateSettings,
  searchEntries,
  isMounted
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  searchEntries: SettingsSearchEntry[]
  isMounted: boolean
}): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  if (settings.experimentalStructuredNativeChat !== true) {
    return null
  }
  const title = translate('settings.appearance.chat.title', 'Chat')
  const appearanceTitle = translate('auto.components.settings.Settings.2b4474780a', 'Appearance')
  return (
    <SettingsSection
      id="chat"
      title={title}
      description={translate('settings.chat.description', 'Choose how chats look.')}
      searchEntries={searchEntries}
    >
      {isMounted ? (
        <div id="chat-appearance" className="space-y-3">
          <SettingsSubsectionHeader title={appearanceTitle} />
          <AppearanceChatSection
            settings={settings}
            updateSettings={updateSettings}
            forceVisiblePrimary={matchesSettingsSearch(query, [
              { title },
              { title: appearanceTitle }
            ])}
          />
        </div>
      ) : null}
    </SettingsSection>
  )
}
