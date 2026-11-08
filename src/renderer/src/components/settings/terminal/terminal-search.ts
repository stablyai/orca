import type { SettingsSearchEntry } from '../search/settings-search'
import {
  getTerminalAdvancedSearchEntries,
  getTerminalConfigImportSearchEntries,
  getTerminalMacOptionSearchEntries,
  getTerminalMacYenSearchEntries
} from './platform/terminal-advanced-platform-search'
import {
  getTerminalPaneAppearanceSearchEntries,
  getTerminalPaneInteractionSearchEntries
} from './appearance/terminal-pane-appearance-search'
import {
  getClaudeCodeThemeSyncSearchEntry,
  getTerminalDarkThemeSearchEntries,
  getTerminalLightThemeSearchEntries,
  getTerminalThemeTargetSearchEntries,
  getTerminalWarpImportSearchEntries,
  getTerminalYamlImportSearchEntries
} from './themes/terminal-theme-search'
import {
  getTerminalCursorSearchEntries,
  getTerminalRenderingSearchEntries,
  getTerminalTypographySearchEntries
} from './appearance/terminal-typography-search'
import {
  getTerminalRightClickToPasteSearchEntry,
  getTerminalWindowsPowershellImplementationSearchEntry,
  getTerminalWindowsShellSearchEntry,
  getTerminalWindowsAdministratorSearchEntry
} from './platform/terminal-windows-search'
import {
  getManageSessionsSearchEntries,
  getTerminalWindowSearchEntries
} from './terminal-window-setup-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { translateSearchKeyword } from '../search/settings-search-keywords'

type TerminalAppearanceSearchOptions = {
  showDesktopThemeImports?: boolean
}

const getTerminalAppearanceSearchEntriesWithoutImports = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    ...getTerminalTypographySearchEntries(),
    ...getTerminalCursorSearchEntries(),
    ...getTerminalPaneAppearanceSearchEntries(),
    ...getTerminalThemeTargetSearchEntries(),
    ...getTerminalDarkThemeSearchEntries(),
    ...getTerminalLightThemeSearchEntries(),
    ...getTerminalWindowSearchEntries()
  ]
)

// Compose catalogs because translated titles cannot reliably identify desktop-only entries.
// Claude Code theme sync writes this computer's Claude config, so web clients do not offer it.
const getTerminalAppearanceSearchEntriesWithImports = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    ...getTerminalAppearanceSearchEntriesWithoutImports(),
    ...getTerminalConfigImportSearchEntries(),
    ...getTerminalWarpImportSearchEntries(),
    ...getTerminalYamlImportSearchEntries(),
    ...getClaudeCodeThemeSyncSearchEntry()
  ]
)

export function getTerminalAppearanceSearchEntries(
  options: TerminalAppearanceSearchOptions = {}
): SettingsSearchEntry[] {
  return (options.showDesktopThemeImports ?? true)
    ? getTerminalAppearanceSearchEntriesWithImports()
    : getTerminalAppearanceSearchEntriesWithoutImports()
}

export function getTerminalPaneSearchEntries(
  platform: {
    isWindows: boolean
    isWindowsTerminalHost?: boolean
    isMac: boolean
  },
  t: Translate = translate
): SettingsSearchEntry[] {
  const isWindowsTerminalHost = platform.isWindowsTerminalHost ?? platform.isWindows
  // Mirror visible platform controls so search cannot link to hidden options.
  return [
    ...getTerminalRenderingSearchEntries(),
    ...getTerminalPaneInteractionSearchEntries(),
    ...(platform.isWindows ? getTerminalWindowsAdministratorSearchEntry() : []),
    ...(!isWindowsTerminalHost
      ? [
          {
            title: t('auto.components.settings.terminal.search.1733ccd3e9', 'Terminal shell'),
            description: t(
              'auto.components.settings.terminal.search.3de504994c',
              'Shell and arguments used for new local interactive terminal panes'
            ),
            keywords: [
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.ddd5efe113',
                'shell',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.f66a7cf715',
                'terminal',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.454df22a5e',
                'fish',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.d26257a80d',
                'zsh',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.bf09070e31',
                'bash',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.7c3ede6f12',
                'nushell',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.5304b12d5c',
                'arguments',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.36ba1a1357',
                'args',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.50ba80b6dd',
                'login',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.d9e29543a1',
                'wrapper',
                undefined,
                t
              ),
              ...translateSearchKeyword(
                'auto.components.settings.terminal.search.d31ed1ac1c',
                'rcfile',
                undefined,
                t
              )
            ]
          }
        ]
      : []),
    ...(isWindowsTerminalHost
      ? [
          ...getTerminalWindowsShellSearchEntry(),
          ...getTerminalWindowsPowershellImplementationSearchEntry()
        ]
      : []),
    ...getTerminalRightClickToPasteSearchEntry(),
    ...getManageSessionsSearchEntries(),
    ...getTerminalAdvancedSearchEntries(),
    ...(platform.isMac
      ? [...getTerminalMacOptionSearchEntries(), ...getTerminalMacYenSearchEntries()]
      : [])
  ]
}
