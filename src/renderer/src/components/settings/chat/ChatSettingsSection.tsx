import { translate } from '@/i18n/i18n'
import { AppearanceChatSection } from '../appearance/chat/AppearanceChatSection'
import { ChatBehaviorSetting } from './ChatBehaviorSetting'
import { ChatNamingSetting } from './ChatNamingSetting'
import { NativeChatInlineVisualsSetting } from './NativeChatInlineVisualsSetting'
import { SettingsSection } from '../section-layout/SettingsSection'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'
import { matchesSettingsSearch, type SettingsSearchEntry } from '../search/settings-search'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'

import { useAppStore } from '../../../store/index'
import { Card, CardContent } from '../../ui/card'
import { getChatAppearanceSearchEntries } from '../appearance/chat/chat-appearance-search'
import { ChatTurnActivitySetting } from './ChatTurnActivitySetting'
import { getChatTurnActivityTitle } from './chat-turn-activity-search'
import { getChatBehaviorTitle } from './chat-behavior-search'
import { AgentDefaultSurfaceSection } from '../agents/surfaces/AgentDefaultSurfaceSection'
import { ChatAgentLaunchSettings } from './ChatAgentLaunchSettings'
import { getChatLaunchEntriesByKey } from './chat-launch-search'
import { SearchableSetting } from '../section-layout/SearchableSetting'

export function ChatSettingsSection({
  settings,
  updateSettings,
  fontSuggestions,
  onRequestFontSuggestions,
  writeSourceControlAiSettings,
  onChatPromptDirtyChange,
  chatPromptDiscardSignal,
  hasUnsavedChatPromptChanges = false,
  searchEntries,
  showDesktopOnlySettings,
  isMounted
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  fontSuggestions?: string[]
  onRequestFontSuggestions?: () => void
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  onChatPromptDirtyChange?: (dirty: boolean) => void
  chatPromptDiscardSignal?: number
  hasUnsavedChatPromptChanges?: boolean
  searchEntries: SettingsSearchEntry[]
  showDesktopOnlySettings: boolean
  isMounted: boolean
}): React.JSX.Element {
  const query = useAppStore((state) => state.settingsSearchQuery)
  const title = translate('settings.appearance.chat.title', 'Chat UI')
  const appearanceTitle = translate('auto.components.settings.Settings.2b4474780a', 'Appearance')
  const launchEntries = getChatLaunchEntriesByKey()
  const showAllBehavior = matchesSettingsSearch(query, [
    { title },
    { title: getChatBehaviorTitle() }
  ])
  return (
    <SettingsSection
      id="chat"
      title={title}
      description={translate('settings.chat.description', 'Choose how chats look and behave.')}
      searchEntries={searchEntries}
      forceVisible={hasUnsavedChatPromptChanges}
      bodyClassName="rounded-none border-0 bg-transparent p-0 shadow-none"
    >
      {isMounted ? (
        <div className="space-y-5">
          {showDesktopOnlySettings ? (
            <>
              <SearchableSetting
                {...launchEntries.default}
                id={launchEntries.default.targetSectionId}
                className="max-w-none"
                forceVisible={matchesSettingsSearch(query, [{ title }])}
              >
                <AgentDefaultSurfaceSection settings={settings} presentation="switch" />
              </SearchableSetting>
              <SearchableSetting
                {...launchEntries.agents}
                id={launchEntries.agents.targetSectionId}
                className="max-w-none"
                forceVisible={matchesSettingsSearch(query, [{ title }])}
              >
                <ChatAgentLaunchSettings settings={settings} updateSettings={updateSettings} />
              </SearchableSetting>
            </>
          ) : null}
          {matchesSettingsSearch(query, [{ title }, ...getChatAppearanceSearchEntries()]) ? (
            <section id="chat-appearance" className="space-y-3">
              <SettingsSubsectionHeader title={appearanceTitle} />
              <Card>
                <CardContent>
                  <AppearanceChatSection
                    settings={settings}
                    updateSettings={updateSettings}
                    fontSuggestions={fontSuggestions}
                    onRequestFontSuggestions={onRequestFontSuggestions}
                    forceVisiblePrimary={matchesSettingsSearch(query, [
                      { title },
                      { title: appearanceTitle }
                    ])}
                  />
                </CardContent>
              </Card>
            </section>
          ) : null}
          <ChatTurnActivitySetting
            settings={settings}
            updateSettings={updateSettings}
            forceVisible={matchesSettingsSearch(query, [
              { title },
              { title: getChatTurnActivityTitle() }
            ])}
          />
          {showDesktopOnlySettings ? (
            <NativeChatInlineVisualsSetting
              settings={settings}
              updateSettings={updateSettings}
              forceVisible={matchesSettingsSearch(query, [{ title }])}
            />
          ) : null}
          <ChatBehaviorSetting
            settings={settings}
            updateSettings={updateSettings}
            forceVisible={showAllBehavior}
          />
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
