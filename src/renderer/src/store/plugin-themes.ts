import {
  isPluginThemeRegistration,
  type PluginThemeRegistration
} from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import {
  isPluginTerminalThemeRegistration,
  type PluginTerminalThemeRegistration
} from '../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import { useEffect } from 'react'
import { createPluginContentListStore } from './plugin-content-list-store'
import { refreshedTerminalPluginPalettes } from '../lib/terminal-plugin-palettes'
import { applyPluginAppTheme, readCachedPluginAppTheme } from '../lib/document-theme'
import { useAppStore } from './index'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { pluginAppThemeSlotUpdate } from '../../../shared/plugin-theme-settings'

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

/** Moves a legacy single plugin theme into its mode's slot and drops a startup paint the
 *  settings no longer back. */
export function usePluginAppThemeSync(): void {
  const pluginThemes = usePluginThemes()
  const loaded = usePluginThemeStore((s) => s.loaded)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const dark = useDocumentDarkTheme()
  const selected = (dark ? settings?.pluginAppThemeDark : settings?.pluginAppThemeLight) ?? null
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

  const legacy = loaded ? pluginThemes.find((theme) => theme.id === settings?.pluginAppTheme) : null
  useEffect(() => {
    // Why wait for the theme: only it knows which slot it belongs in; `theme` already holds its base.
    if (legacy) {
      void updateSettings({
        ...pluginAppThemeSlotUpdate(legacy.base, legacy.id),
        pluginAppTheme: null,
        themeBeforePlugin: null
      })
    }
  }, [legacy, updateSettings])
}
