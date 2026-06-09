import type { SettingsSearchEntry } from './settings-search'
import {
  getTerminalAdvancedSearchEntries,
  getTerminalGhosttyImportSearchEntries,
  getTerminalMacOptionSearchEntries,
  getTerminalMacYenSearchEntries
} from './terminal-advanced-platform-search'
import {
  getTerminalPaneAppearanceSearchEntries,
  getTerminalPaneInteractionSearchEntries
} from './terminal-pane-appearance-search'
import {
  getTerminalDarkThemeSearchEntries,
  getTerminalLightThemeSearchEntries
} from './terminal-theme-search'
import {
  getTerminalCursorSearchEntries,
  getTerminalRenderingSearchEntries,
  getTerminalTypographySearchEntries
} from './terminal-typography-search'
import { getTerminalWindowsSearchEntries } from './terminal-windows-search'
import {
  getManageSessionsSearchEntries,
  getTerminalSetupScriptSearchEntries,
  getTerminalWindowSearchEntries
} from './terminal-window-setup-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export {
  getTerminalTypographySearchEntries,
  getTerminalRenderingSearchEntries,
  getTerminalCursorSearchEntries
} from './terminal-typography-search'
export {
  getTerminalPaneAppearanceSearchEntries,
  getTerminalPaneInteractionSearchEntries
} from './terminal-pane-appearance-search'
export {
  getTerminalDarkThemeSearchEntries,
  getTerminalLightThemeSearchEntries
} from './terminal-theme-search'
export {
  getTerminalAdvancedSearchEntries,
  getTerminalMacOptionSearchEntries,
  getTerminalMacYenSearchEntries,
  getTerminalGhosttyImportSearchEntries
} from './terminal-advanced-platform-search'
export {
  getManageSessionsSearchEntries,
  getTerminalWindowSearchEntries,
  getTerminalSetupScriptSearchEntries
} from './terminal-window-setup-search'

export const getTerminalAppearanceSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    ...getTerminalTypographySearchEntries(),
    ...getTerminalCursorSearchEntries(),
    ...getTerminalPaneAppearanceSearchEntries(),
    ...getTerminalDarkThemeSearchEntries(),
    ...getTerminalLightThemeSearchEntries(),
    ...getTerminalWindowSearchEntries(),
    ...getTerminalGhosttyImportSearchEntries()
  ]
)

export function getTerminalPaneSearchEntries(platform: {
  isWindows: boolean
  isMac: boolean
}): SettingsSearchEntry[] {
  // Why: the settings search index must mirror the visible controls. Keeping
  // platform-only controls out of other platforms' search results prevents
  // users from landing on an option the UI intentionally hides.
  return [
    ...getTerminalRenderingSearchEntries(),
    ...getTerminalPaneInteractionSearchEntries(),
    ...(platform.isWindows ? getTerminalWindowsSearchEntries() : []),
    ...getTerminalSetupScriptSearchEntries(),
    ...getManageSessionsSearchEntries(),
    ...getTerminalAdvancedSearchEntries(),
    ...(platform.isMac
      ? [...getTerminalMacOptionSearchEntries(), ...getTerminalMacYenSearchEntries()]
      : [])
  ]
}
