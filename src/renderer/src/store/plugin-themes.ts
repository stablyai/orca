import {
  isPluginThemeRegistration,
  type PluginThemeRegistration
} from '../../../shared/plugins/plugin-theme-artifact'
import {
  isPluginTerminalThemeRegistration,
  type PluginTerminalThemeRegistration
} from '../../../shared/plugins/plugin-terminal-theme-artifact'
import { useEffect } from 'react'
import { createPluginContentListStore } from './plugin-content-list-store'
import { refreshedTerminalPluginPalettes } from '../lib/terminal-plugin-palettes'
import { applyPluginAppTheme, readCachedPluginAppTheme } from '../lib/document-theme'
import { useAppStore } from './index'

const appThemes = createPluginContentListStore<PluginThemeRegistration>({
  kind: 'themes',
  list: (api) => api.listThemes,
  isEntry: isPluginThemeRegistration
})

const terminalThemes = createPluginContentListStore<PluginTerminalThemeRegistration>({
  kind: 'terminal themes',
  list: (api) => api.listTerminalThemes,
  isEntry: isPluginTerminalThemeRegistration
})

export const usePluginThemeStore = appThemes.useStore
export const usePluginThemes = appThemes.useEntries
export const usePluginTerminalThemeStore = terminalThemes.useStore
export const usePluginTerminalThemes = terminalThemes.useEntries

/** Keeps the saved snapshot of selected plugin terminal palettes current as plugins update. */
export function usePluginTerminalPaletteRefresh(): void {
  const pluginTerminalThemes = usePluginTerminalThemes()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  useEffect(() => {
    const update = settings && refreshedTerminalPluginPalettes(settings, pluginTerminalThemes)
    if (update) {
      void updateSettings(update)
    }
  }, [settings, pluginTerminalThemes, updateSettings])
}

function pluginKeyOf(id: string): string {
  return id.slice('plugin:'.length, id.lastIndexOf('/'))
}

/** Keeps `theme` equal to the selected plugin theme's base while it is enabled, restores the
 *  user's earlier choice while it is not, and drops a startup paint the settings no longer back. */
export function usePluginAppThemeSync(): void {
  const pluginThemes = usePluginThemes()
  const loaded = usePluginThemeStore((s) => s.loaded)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const selected = settings?.pluginAppTheme ?? null
  const disabled =
    !selected ||
    settings?.pluginSystemEnabled === false ||
    (settings?.disabledPlugins ?? []).includes(pluginKeyOf(selected))

  useEffect(() => {
    const cached = readCachedPluginAppTheme()
    // Why before the list loads: the settings already say whether the cached paint still applies.
    if (settings && !loaded && cached && (cached.id !== selected || disabled)) {
      applyPluginAppTheme(null)
    }
  }, [settings, loaded, selected, disabled])

  useEffect(() => {
    if (!settings || !loaded || !selected) {
      return
    }
    const active = pluginThemes.find((theme) => theme.id === selected)
    const target = active ? active.base : settings.themeBeforePlugin
    if (target && settings.theme !== target) {
      void updateSettings({ theme: target })
    }
  }, [settings, loaded, selected, pluginThemes, updateSettings])
}
