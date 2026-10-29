import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { PluginIconThemeMetadata } from '../../../../../shared/plugins/artifacts/plugin-icon-theme-artifact'
import type { PluginLanguagePackRegistration } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import type { PluginTerminalThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import type { PluginThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { isUsablePluginLanguagePack } from '../../../../../shared/plugins/languages/plugin-language-pack-coverage'
import { useAppStore } from '@/store'
import { isPluginAppThemeSelected } from './plugin-theme-apply'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'
import { usePluginLanguagePacks } from '@/store/plugin-language-packs'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugin-themes'

type ThemeMode = 'light' | 'dark'

/** Whether a plugin's switchable contribution is the active one; `slot` names the one mode it
 *  fills when it fills only one. Null when it offers nothing to switch to. */
export type PluginInUse =
  | { kind: 'in-use'; slot: ThemeMode | null }
  | { kind: 'available'; languagePack: PluginLanguagePackRegistration | null }
  | null

export function pluginInUse(
  pluginKey: string,
  settings: Pick<
    GlobalSettings,
    | 'pluginAppThemeDark'
    | 'pluginAppThemeLight'
    | 'pluginIconTheme'
    | 'terminalThemeDark'
    | 'terminalThemeLight'
    | 'terminalUseSeparateLightTheme'
    | 'uiLanguage'
  >,
  registered: {
    appThemes: readonly PluginThemeRegistration[]
    terminalThemes: readonly PluginTerminalThemeRegistration[]
    iconThemes: readonly PluginIconThemeMetadata[]
    languagePacks: readonly PluginLanguagePackRegistration[]
  }
): PluginInUse {
  const ours = <Entry extends { pluginKey: string }>(entries: readonly Entry[]): Entry[] =>
    entries.filter((entry) => entry.pluginKey === pluginKey)
  const apps = ours(registered.appThemes)
  const terminals = ours(registered.terminalThemes)
  const icons = ours(registered.iconThemes)
  const packs = ours(registered.languagePacks).filter(isUsablePluginLanguagePack)
  if (apps.length + terminals.length + icons.length + packs.length === 0) {
    return null
  }
  const slots = new Set<ThemeMode>()
  for (const theme of apps) {
    if (isPluginAppThemeSelected(settings, theme)) {
      slots.add(theme.base)
    }
  }
  // Why app themes first: they name the slot; a pack's terminal colours just follow it.
  for (const theme of apps.length > 0 ? [] : terminals) {
    if (settings.terminalThemeDark === theme.id) {
      slots.add('dark')
    }
    if (settings.terminalUseSeparateLightTheme && settings.terminalThemeLight === theme.id) {
      slots.add('light')
    }
  }
  const other =
    icons.some((theme) => settings.pluginIconTheme === theme.id) ||
    packs.some((pack) => settings.uiLanguage === pack.id)
  if (slots.size > 0 || other) {
    return { kind: 'in-use', slot: slots.size === 1 && !other ? [...slots][0] : null }
  }
  return {
    kind: 'available',
    languagePack: apps.length + terminals.length + icons.length === 0 ? packs[0] : null
  }
}

/** Live in-use state of an installed plugin's themes, icon theme or language pack. */
export function usePluginInUse(pluginKey: string | null): PluginInUse {
  const appThemes = usePluginThemes()
  const terminalThemes = usePluginTerminalThemes()
  const iconThemes = usePluginIconThemes()
  const languagePacks = usePluginLanguagePacks()
  const settings = useAppStore((state) => state.settings)
  if (!pluginKey || !settings) {
    return null
  }
  return pluginInUse(pluginKey, settings, {
    appThemes,
    terminalThemes,
    iconThemes,
    languagePacks
  })
}
