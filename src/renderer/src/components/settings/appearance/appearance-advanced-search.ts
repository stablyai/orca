import type { SettingsSearchEntry } from '../search/settings-search'
import { getTitlebarEntries } from './appearance-search'
import { getMenuBarIconEntries, getSystemTrayEntries } from './appearance-system-presence-search'
import { getWindowTitleEntries } from './appearance-window-title-search'
import { getReduceVisualEffectsEntries } from './appearance-reduce-visual-effects-search'

/** Settings inside the Interface section's Advanced disclosure; a search hit on any of them reveals it. */
export function getAppearanceAdvancedEntries(options: {
  isDesktopWindows: boolean
  isDesktopMac: boolean
}): SettingsSearchEntry[] {
  return [
    ...getTitlebarEntries(),
    ...getWindowTitleEntries(),
    ...getReduceVisualEffectsEntries(),
    ...getSystemTrayEntries({ showSystemTray: options.isDesktopWindows }),
    ...getMenuBarIconEntries({ showMenuBarIcon: options.isDesktopMac })
  ]
}
