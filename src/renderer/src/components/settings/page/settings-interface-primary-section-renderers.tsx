import { BrowserPane } from '../browser/BrowserPane'
import { FloatingWorkspacePane } from '../floating-workspaces/FloatingWorkspacePane'
import { MobileEmulatorSettingsPane } from '../mobile/emulator/MobileEmulatorSettingsPane'
import { QuickCommandsPane } from '../quick-commands/QuickCommandsPane'
import { TerminalPane } from '../terminal/TerminalPane'
import { SettingsSection } from '../section-layout/SettingsSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

export function renderTerminalSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, terminal, view } = context
  return (
    <SettingsSection
      id="terminal"
      grouped
      title={t('auto.components.settings.Settings.3de4bbb841', 'Terminal')}
      description={t(
        'auto.components.settings.Settings.b79b5b31e9',
        'Shells, renderer, sessions, and terminal behavior.'
      )}
      searchEntries={navigation.getSectionSearchEntries('terminal')}
    >
      {view.isSectionMounted('terminal') ? (
        <TerminalPane
          hostScope={model.settingsHostScope}
          settings={model.settings}
          updateSettings={model.updateSettings}
          scrollbackMode={model.scrollbackMode}
          setScrollbackMode={model.setScrollbackMode}
          wslAvailable={terminal.windowsTerminalCapabilities.wslAvailable}
          wslDistros={terminal.windowsTerminalCapabilities.wslDistros}
          wslCapabilitiesLoading={terminal.windowsTerminalCapabilities.isLoading}
          pwshAvailable={terminal.windowsTerminalCapabilities.pwshAvailable}
          gitBashAvailable={terminal.windowsTerminalCapabilities.gitBashAvailable}
          isWindowsTerminalHost={terminal.isWindowsTerminalHost}
        />
      ) : null}
    </SettingsSection>
  )
}

export function renderQuickCommandsSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="quick-commands"
      title={t('auto.components.settings.Settings.d60b7f0e58', 'Quick commands')}
      description={t(
        'auto.components.settings.Settings.6742c7932c',
        'Saved terminal commands, scoped globally or per project.'
      )}
      searchEntries={navigation.getSectionSearchEntries('quick-commands')}
    >
      {view.isSectionMounted('quick-commands') ? (
        <QuickCommandsPane
          settings={model.settings}
          addCommandIntentSignal={model.quickCommandAddIntentSignal}
        />
      ) : null}
    </SettingsSection>
  )
}

export function renderBrowserSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, actions, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <SettingsSection
      id="browser"
      grouped
      title={t('auto.components.settings.Settings.c46215ea03', 'Browser')}
      description={t(
        'auto.components.settings.Settings.ad9788036f',
        'Home page, link routing, and session cookies.'
      )}
      searchEntries={navigation.getSectionSearchEntries('browser')}
    >
      {view.isSectionMounted('browser') ? (
        <BrowserPane
          settings={model.settings}
          updateSettings={model.updateSettings}
          onOpenComputerUse={actions.openComputerUseFromBrowser}
        />
      ) : null}
    </SettingsSection>
  ) : null
}

export function renderMobileEmulatorSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <SettingsSection
      id="mobile-emulator"
      grouped
      title={t('auto.components.settings.Settings.129ae9859c', 'Mobile emulator')}
      description={t(
        'auto.components.settings.Settings.01f9d36292',
        'Configure mobile emulator support for Orca and coding agents.'
      )}
      searchEntries={navigation.getSectionSearchEntries('mobile-emulator')}
    >
      {view.isSectionMounted('mobile-emulator') ? (
        <MobileEmulatorSettingsPane
          settings={model.settings}
          updateSettings={model.updateSettings}
        />
      ) : null}
    </SettingsSection>
  ) : null
}

export function renderFloatingWorkspaceSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="floating-workspace"
      title={t('auto.components.settings.Settings.c2bb9fc528', 'Floating workspace')}
      description={t(
        'auto.components.settings.Settings.3d9adfe6a5',
        'Global terminal, browser, and markdown tabs.'
      )}
      searchEntries={navigation.getSectionSearchEntries('floating-workspace')}
    >
      {view.isSectionMounted('floating-workspace') ? (
        <FloatingWorkspacePane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  )
}
