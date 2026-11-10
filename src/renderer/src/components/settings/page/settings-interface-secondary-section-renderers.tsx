import { StatsPane } from '../../stats/StatsPane'
import { AppearancePane } from '../appearance/AppearancePane'
import { ChatSettingsSection } from '../chat/ChatSettingsSection'
import { InputPane } from '../input/InputPane'
import { NotificationsPane } from '../notifications/NotificationsPane'
import { ShortcutsPane } from '../shortcuts/ShortcutsPane'
import { SettingsSection } from '../section-layout/SettingsSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

export function renderAppearanceSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, interactions, navigation, view } = context
  return (
    <SettingsSection
      id="appearance"
      grouped
      title={t('auto.components.settings.Settings.2b4474780a', 'Appearance')}
      description={t(
        'auto.components.settings.Settings.6d1a27e193',
        'Theme, zoom, app and terminal appearance, sidebars, and status bar.'
      )}
      searchEntries={navigation.getSectionSearchEntries('appearance')}
    >
      {view.isSectionMounted('appearance') ? (
        <AppearancePane
          settings={model.settings}
          updateSettings={model.updateSettings}
          applyTheme={navigation.applyTheme}
          fontSuggestions={model.fontSuggestions}
          terminalFontSuggestions={model.terminalFontSuggestions}
          onRequestFontSuggestions={interactions.requestFontSuggestions}
          systemPrefersDark={model.systemPrefersDark}
          terminalConfigImport={model.terminalConfigImport}
          warpThemes={model.warpThemes}
        />
      ) : null}
    </SettingsSection>
  )
}

export type ChatSettingsRenderContext = {
  model: Pick<
    SettingsRenderContext['model'],
    | 'settings'
    | 'fontSuggestions'
    | 'updateSettings'
    | 'setHasUnsavedChatPromptChanges'
    | 'sourceControlAiPromptDiscardSignal'
    | 'hasUnsavedChatPromptChanges'
    | 'showDesktopOnlySettings'
  >
  interactions: Pick<
    SettingsRenderContext['interactions'],
    'writeSourceControlAiSettingsOrThrow' | 'requestFontSuggestions'
  >
  navigation: Pick<SettingsRenderContext['navigation'], 'getSectionSearchEntries'>
  view: Pick<SettingsRenderContext['view'], 'isSectionMounted'>
}

export function renderChatSettingsSection(context: ChatSettingsRenderContext): React.JSX.Element {
  const { model, interactions, navigation, view } = context
  return (
    <ChatSettingsSection
      settings={model.settings}
      fontSuggestions={model.fontSuggestions}
      onRequestFontSuggestions={interactions.requestFontSuggestions}
      updateSettings={model.updateSettings}
      writeSourceControlAiSettings={interactions.writeSourceControlAiSettingsOrThrow}
      onChatPromptDirtyChange={model.setHasUnsavedChatPromptChanges}
      chatPromptDiscardSignal={model.sourceControlAiPromptDiscardSignal}
      hasUnsavedChatPromptChanges={model.hasUnsavedChatPromptChanges}
      searchEntries={navigation.getSectionSearchEntries('chat')}
      showDesktopOnlySettings={model.showDesktopOnlySettings}
      isMounted={view.isSectionMounted('chat')}
    />
  )
}

export function renderInputSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation } = context
  return (
    <SettingsSection
      id="input"
      title={t('auto.components.settings.Settings.f1fddf7764', 'Input & editing')}
      description={t(
        'auto.components.settings.Settings.d0b7021d64',
        'Selection and editing behavior.'
      )}
      searchEntries={navigation.getSectionSearchEntries('input')}
    >
      <InputPane settings={model.settings} updateSettings={model.updateSettings} />
    </SettingsSection>
  )
}

export function renderNotificationsSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <SettingsSection
      id="notifications"
      title={t('auto.components.settings.Settings.9907545fa3', 'Notifications')}
      description={t(
        'auto.components.settings.Settings.7210ac09c4',
        'Native desktop notifications for agent activity and terminal events.'
      )}
      searchEntries={navigation.getSectionSearchEntries('notifications')}
    >
      {view.isSectionMounted('notifications') ? (
        <NotificationsPane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  ) : null
}

export function renderShortcutsSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { navigation, view } = context
  return (
    <SettingsSection
      id="shortcuts"
      title={t('auto.components.settings.Settings.23bf7a1ad4', 'Shortcuts')}
      description={t(
        'auto.components.settings.Settings.a737a4bb22',
        'Keyboard shortcuts for common actions.'
      )}
      searchEntries={navigation.getSectionSearchEntries('shortcuts')}
      className={
        view.isFocusedShortcutsPane ? 'flex min-h-0 flex-1 flex-col space-y-0 gap-6' : undefined
      }
      bodyClassName={view.isFocusedShortcutsPane ? 'min-h-0 flex-1 overflow-hidden' : undefined}
    >
      {view.isSectionMounted('shortcuts') ? <ShortcutsPane /> : null}
    </SettingsSection>
  )
}

export function renderStatsSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { navigation, view } = context
  return (
    <SettingsSection
      id="stats"
      title={t('auto.components.settings.Settings.084f34826d', 'Stats & usage')}
      description={t(
        'auto.components.settings.Settings.8acf3f22e0',
        'Orca stats plus Claude, Codex, OpenCode, Muse token analytics and Grok subscription usage.'
      )}
      searchEntries={navigation.getSectionSearchEntries('stats')}
    >
      {view.isSectionMounted('stats') ? <StatsPane /> : null}
    </SettingsSection>
  )
}
