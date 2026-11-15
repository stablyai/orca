import { useTranslate } from '@/i18n/use-translate'
import { AppearanceChatSection } from '../appearance/chat/AppearanceChatSection'
import { ChatBehaviorSetting } from './ChatBehaviorSetting'
import { ChatNamingSetting } from './ChatNamingSetting'
import { NativeChatInlineVisualsSetting } from './NativeChatInlineVisualsSetting'
import { SettingsSection } from '../section-layout/SettingsSection'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { matchesSettingsSearch, type SettingsSearchEntry } from '../search/settings-search'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'

import { useAppStore } from '../../../store/index'
import { getChatAppearanceSearchEntries } from '../appearance/chat/chat-appearance-search'
import { ChatSpeechSetting } from './ChatSpeechSetting'
import { ChatTurnActivitySetting } from './ChatTurnActivitySetting'
import { getChatSpeechSearchEntries } from './chat-speech-search'
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
  const t = useTranslate()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const title = t('settings.appearance.chat.title', 'Chat UI')
  const appearanceTitle = t('auto.components.settings.Settings.2b4474780a', 'Appearance')
  const launchEntries = getChatLaunchEntriesByKey(t)
  const showAllBehavior = matchesSettingsSearch(query, [
    { title },
    { title: getChatBehaviorTitle(t) }
  ])
  return (
    <SettingsSection
      id="chat"
      title={title}
      description={t('settings.chat.description', 'Choose how chats look and behave.')}
      searchEntries={searchEntries}
      forceVisible={hasUnsavedChatPromptChanges}
    >
      {isMounted ? (
        <>
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
          {matchesSettingsSearch(query, [{ title }, ...getChatAppearanceSearchEntries(t)]) ? (
            <SettingsGroup id="chat-appearance" title={appearanceTitle}>
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
            </SettingsGroup>
          ) : null}
          <ChatTurnActivitySetting
            settings={settings}
            updateSettings={updateSettings}
            forceVisible={matchesSettingsSearch(query, [
              { title },
              { title: getChatTurnActivityTitle(t) }
            ])}
          />
          <ChatSpeechSetting
            settings={settings}
            updateSettings={updateSettings}
            showEngine={showDesktopOnlySettings}
            forceVisible={matchesSettingsSearch(query, [
              { title },
              ...getChatSpeechSearchEntries(t, { includeEngine: showDesktopOnlySettings })
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
        </>
      ) : null}
    </SettingsSection>
  )
}
