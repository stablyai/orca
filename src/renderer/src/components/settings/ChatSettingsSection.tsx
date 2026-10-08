import { translate } from '@/i18n/i18n'
import { AppearanceChatSection } from './AppearanceChatSection'
import { ChatNamingSetting } from './ChatNamingSetting'
import { SettingsSection } from './SettingsSection'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import type { SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'
import { Card, CardContent } from '../ui/card'
import { getChatAppearanceSearchEntries } from './chat-appearance-search'

export function ChatSettingsSection({
  settings,
  updateSettings,
  writeSourceControlAiSettings,
  onChatPromptDirtyChange,
  chatPromptDiscardSignal,
  hasUnsavedChatPromptChanges = false,
  searchEntries,
  showDesktopOnlySettings,
  isMounted
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  onChatPromptDirtyChange?: (dirty: boolean) => void
  chatPromptDiscardSignal?: number
  hasUnsavedChatPromptChanges?: boolean
  searchEntries: SettingsSearchEntry[]
  showDesktopOnlySettings: boolean
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
      description={translate(
        'settings.chat.description',
        'Choose how chats look and get their names.'
      )}
      searchEntries={searchEntries}
      forceVisible={hasUnsavedChatPromptChanges}
      bodyClassName="rounded-none border-0 bg-transparent p-0 shadow-none"
    >
      {isMounted ? (
        <div className="space-y-5">
          {matchesSettingsSearch(query, [{ title }, ...getChatAppearanceSearchEntries()]) ? (
            <section id="chat-appearance" className="space-y-3">
              <SettingsSubsectionHeader title={appearanceTitle} />
              <Card>
                <CardContent>
                  <AppearanceChatSection
                    settings={settings}
                    updateSettings={updateSettings}
                    forceVisiblePrimary={matchesSettingsSearch(query, [
                      { title },
                      { title: appearanceTitle }
                    ])}
                  />
                </CardContent>
              </Card>
            </section>
          ) : null}
          {showDesktopOnlySettings ? (
            <ChatNamingSetting
              key={chatPromptDiscardSignal}
              settings={settings}
              updateSettings={updateSettings}
              writeSourceControlAiSettings={writeSourceControlAiSettings}
              onDirtyChange={onChatPromptDirtyChange}
              forceVisible={
                matchesSettingsSearch(query, [{ title }]) || hasUnsavedChatPromptChanges
              }
            />
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  )
}
