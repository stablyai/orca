import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

const getSystemTrayEntryCatalog = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate(
      'auto.components.settings.AppearancePane.keepServingOnClose.title',
      'Keep Serving on Close'
    ),
    description: translate(
      'auto.components.settings.AppearancePane.keepServingOnClose.description',
      'When enabled, closing the window keeps Orca running so remote, mobile, and SSH clients stay served, instead of quitting.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.appearance.search.tray.tray', 'tray', {
        englishOnly: true
      }),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.tray.system',
        'system tray',
        { englishOnly: true }
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.tray.serving',
        'keep serving remote',
        { englishOnly: true }
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.tray.close', 'close', {
        englishOnly: true
      }),
      ...translateSearchKeyword('auto.components.settings.appearance.search.e5bc35d59e', 'window'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.tray.notification',
        'notification area',
        { englishOnly: true }
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.tray.background',
        'background',
        { englishOnly: true }
      )
    ]
  }
])

const getMenuBarIconEntryCatalog = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('settings.appearance.menuBarIcon.title', 'Show Menu Bar Icon'),
    description: translate(
      'settings.appearance.menuBarIcon.description',
      'Keep an Orca shortcut and activity indicator in the macOS menu bar.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.appearance.menuBarIcon.keyword.menuBar', 'menu bar', {
        englishOnly: true
      }),
      ...translateSearchKeyword('auto.components.settings.appearance.search.tray.tray', 'tray', {
        englishOnly: true
      }),
      ...translateSearchKeyword('auto.components.settings.appearance.search.1f2880a9d5', 'orca'),
      ...translateSearchKeyword(
        'settings.appearance.menuBarIcon.keyword.statusItem',
        'status item',
        { englishOnly: true }
      ),
      ...translateSearchKeyword('settings.appearance.menuBarIcon.keyword.activity', 'activity', {
        englishOnly: true
      }),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.tray.background',
        'background',
        { englishOnly: true }
      )
    ]
  }
])

type SystemPresenceSearchOptions = {
  showMenuBarIcon?: boolean
  showSystemTray?: boolean
}

export function getSystemTrayEntries(
  options: SystemPresenceSearchOptions = {}
): SettingsSearchEntry[] {
  const show =
    options.showSystemTray ??
    // Why: the close behavior is available on every desktop platform, while a
    // web client has no local window lifecycle to control.
    !isWebClientLocation()
  return show ? getSystemTrayEntryCatalog() : []
}

export function getMenuBarIconEntries(
  options: SystemPresenceSearchOptions = {}
): SettingsSearchEntry[] {
  const show =
    options.showMenuBarIcon ?? (getRendererAppPlatform() === 'darwin' && !isWebClientLocation())
  return show ? getMenuBarIconEntryCatalog() : []
}
