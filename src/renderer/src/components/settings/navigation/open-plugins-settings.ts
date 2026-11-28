import { useAppStore } from '@/store/index'
import type { SettingsNavigationTarget } from './settings-navigation-types'

function navigateToPluginsSettings(intent?: SettingsNavigationTarget['intent']): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({ pane: 'plugins', repoId: null, intent })
  state.openSettingsPage()
}

export function openPluginsSettings(): void {
  navigateToPluginsSettings()
}

export function togglePluginsSettings(): void {
  navigateToPluginsSettings('toggle')
}

/** Settings > Plugins only switches panes; the rail's Plugins page opens Settings first. */
export function openShortcutsSettingsFromPlugins(fromRailPage: boolean): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({ pane: 'shortcuts', repoId: null })
  if (fromRailPage) {
    state.openSettingsPage()
  }
}
