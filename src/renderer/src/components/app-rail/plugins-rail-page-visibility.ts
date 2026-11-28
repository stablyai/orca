import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'

type PluginsEntrySettings = Partial<
  Pick<GlobalSettings, 'showPluginsButton' | 'experimentalAppRail'>
> | null

/** Off until checked in the rail's "…" menu; plugins are desktop-only, like Settings > Plugins. */
export function shouldShowPluginsRailPage(
  settings: PluginsEntrySettings | undefined,
  webClient = isWebClientLocation()
): boolean {
  return settings?.showPluginsButton === true && !webClient
}

/** With the app rail on, Plugins lives on the rail (or Settings), so the status bar drops its shortcut. */
export function shouldShowPluginsStatusSegment(
  settings: PluginsEntrySettings | undefined
): boolean {
  return settings?.experimentalAppRail !== true
}
