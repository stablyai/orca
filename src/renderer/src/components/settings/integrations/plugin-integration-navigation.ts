import { create } from 'zustand'
import { useAppStore } from '@/store'
import {
  isLivePlugin,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'

export const PLUGIN_INTEGRATION_SETTINGS_TARGET = 'plugin-integration-settings'

export const usePluginIntegrationNavigation = create<{
  pluginKey: string | null
  show: (pluginKey: string | null) => void
}>()((set) => ({ pluginKey: null, show: (pluginKey) => set({ pluginKey }) }))

/** Resolve from the installed catalog each time; a persisted route never authorizes plugin code. */
export function openPluginIntegrationSettings(pluginKey: string): boolean {
  const plugin = usePluginPanelsStore
    .getState()
    .plugins.find((entry) => entry.pluginKey === pluginKey)
  if (
    !plugin ||
    !isLivePlugin(plugin) ||
    plugin.needsReconsent ||
    !plugin.panels.some((panel) => panel.location === 'settings')
  ) {
    return false
  }
  usePluginIntegrationNavigation.getState().show(pluginKey)
  const state = useAppStore.getState()
  state.openSettingsTarget({
    pane: 'integrations',
    repoId: null,
    sectionId: PLUGIN_INTEGRATION_SETTINGS_TARGET
  })
  state.openSettingsPage()
  return true
}
