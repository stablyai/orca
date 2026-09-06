import { StatsPane } from '../stats/StatsPane'
import { AppearancePane } from './AppearancePane'
import { InputPane } from './InputPane'
import { NotificationsPane } from './NotificationsPane'
import { ShortcutsPane } from './ShortcutsPane'
import { SettingsSection } from './SettingsSection'
import { translate } from '@/i18n/i18n'
import type { SettingsRenderContext } from './settings-render-context'

export function renderAppearanceSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { model, interactions, navigation, view } = context
  return (
    <SettingsSection
      id="appearance"
      title={translate('auto.components.settings.Settings.2b4474780a', 'Appearance')}
      description={translate(
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
          ghostty={model.ghostty}
          warpThemes={model.warpThemes}
        />
      ) : null}
    </SettingsSection>
  )
}

export function renderInputSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { model, navigation } = context
  return (
    <SettingsSection
      id="input"
      title={translate('auto.components.settings.Settings.d7a3e635b6', 'Input & Editing')}
      description={translate(
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
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <SettingsSection
      id="notifications"
      title={translate('auto.components.settings.Settings.9907545fa3', 'Notifications')}
      description={translate(
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

export function renderShortcutsSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { navigation, view } = context
  return (
    <SettingsSection
      id="shortcuts"
      title={translate('auto.components.settings.Settings.23bf7a1ad4', 'Shortcuts')}
      description={translate(
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

export function renderStatsSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { navigation, view } = context
  return (
    <SettingsSection
      id="stats"
      title={translate('auto.components.settings.Settings.954a8f5aef', 'Stats & Usage')}
      description={translate(
        'auto.components.settings.Settings.8acf3f22e0',
        'Orca stats plus Claude, Codex, OpenCode token analytics and Grok subscription usage.'
      )}
      searchEntries={navigation.getSectionSearchEntries('stats')}
    >
      {view.isSectionMounted('stats') ? <StatsPane /> : null}
    </SettingsSection>
  )
}
