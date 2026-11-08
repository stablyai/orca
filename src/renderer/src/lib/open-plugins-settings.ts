import { useAppStore } from '@/store'
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
