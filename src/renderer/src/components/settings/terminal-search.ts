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
  getTerminalLightThemeSearchEntries,
  getTerminalWarpImportSearchEntries
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
  getTerminalLightThemeSearchEntries,
  getTerminalWarpImportSearchEntries
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

type TerminalAppearanceSearchOptions = {
  showWarpImport?: boolean
}

const getTerminalAppearanceSearchEntriesWithWarp = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    ...getTerminalTypographySearchEntries(),
    ...getTerminalCursorSearchEntries(),
    ...getTerminalPaneAppearanceSearchEntries(),
    ...getTerminalDarkThemeSearchEntries(),
    ...getTerminalLightThemeSearchEntries(),
    ...getTerminalWindowSearchEntries(),
    ...getTerminalGhosttyImportSearchEntries(),
    ...getTerminalWarpImportSearchEntries()
  ]
)

const getTerminalAppearanceSearchEntriesWithoutWarp = createLocalizedCatalog(
  (): SettingsSearchEntry[] =>
    getTerminalAppearanceSearchEntriesWithWarp().filter(
      (entry) => entry.title !== 'Import themes from Warp'
    )
)

export function getTerminalAppearanceSearchEntries(
  options: TerminalAppearanceSearchOptions = {}
): SettingsSearchEntry[] {
  return (options.showWarpImport ?? true)
    ? getTerminalAppearanceSearchEntriesWithWarp()
    : getTerminalAppearanceSearchEntriesWithoutWarp()
}

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
