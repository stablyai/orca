import { useAppStore } from '@/store/index'
import { openPluginsSettings } from '@/components/settings/navigation/open-plugins-settings'
import { selectAppRailVisible } from './app-rail-layout'
import { activateRailDestination } from './app-rail-destinations'
import { shouldShowPluginsRailPage } from './plugins-rail-page-visibility'

/** The Plugins shortcut: the rail's Plugins page when it is shown, else Settings > Plugins. */
export function openPluginsFromShortcut(): void {
  const state = useAppStore.getState()
  if (selectAppRailVisible(state) && shouldShowPluginsRailPage(state.settings)) {
    activateRailDestination('plugins')
    return
  }
  openPluginsSettings()
}
