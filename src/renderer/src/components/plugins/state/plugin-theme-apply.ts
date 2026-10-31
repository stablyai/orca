import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { PluginThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import { translate } from '@/i18n/i18n'
import { resolveDocumentTheme } from '@/lib/document-theme'
import { pluginAppThemeSlotUpdate } from '../../../../../shared/plugin-theme-settings'
import { withTerminalPluginPalettes } from '@/lib/terminal-plugin-palettes'
import { useAppStore } from '@/store'
import { PLUGIN_ACTION_TOAST_DURATION_MS } from './plugin-action-toast'
import { usePluginIconThemeStore } from '@/store/plugin-icon-themes'
import { usePluginThemeStore, usePluginTerminalThemeStore } from '@/store/plugin-themes'

export function isPluginAppThemeSelected(
  settings: Pick<GlobalSettings, 'pluginAppThemeDark' | 'pluginAppThemeLight'>,
  theme: Pick<PluginThemeRegistration, 'id' | 'base'>
): boolean {
  return (
    (theme.base === 'dark' ? settings.pluginAppThemeDark : settings.pluginAppThemeLight) ===
    theme.id
  )
}

function terminalSlot(
  mode: PluginTerminalThemeRegistration['mode'],
  dark: boolean
): 'terminalThemeDark' | 'terminalThemeLight' {
  return mode === 'light' || (mode === 'unknown' && !dark)
    ? 'terminalThemeLight'
    : 'terminalThemeDark'
}

export function isPluginTerminalThemeSelected(
  settings: GlobalSettings,
  theme: PluginTerminalThemeRegistration,
  dark: boolean
): boolean {
  // Why the showing slot too: a lone theme for the other mode is applied where it can be seen.
  return [terminalSlot(theme.mode, dark), terminalSlot('unknown', dark)].some(
    (slot) =>
      settings[slot] === theme.id &&
      (slot === 'terminalThemeDark' || settings.terminalUseSeparateLightTheme)
  )
}

export function terminalThemeSlotUpdate(
  theme: Pick<PluginTerminalThemeRegistration, 'id' | 'mode'>,
  dark: boolean
): Partial<
  Pick<GlobalSettings, 'terminalThemeDark' | 'terminalThemeLight' | 'terminalUseSeparateLightTheme'>
> {
  const slot = terminalSlot(theme.mode, dark)
  return {
    [slot]: theme.id,
    ...(slot === 'terminalThemeLight' ? { terminalUseSeparateLightTheme: true } : {})
  }
}

export function terminalThemeUpdate(
  settings: GlobalSettings,
  theme: PluginTerminalThemeRegistration,
  dark: boolean,
  terminalThemes: readonly PluginTerminalThemeRegistration[]
): Partial<GlobalSettings> {
  return withTerminalPluginPalettes(
    settings,
    {
      ...terminalThemeSlotUpdate(theme, dark),
      // A selected theme must replace overrides or they mask its palette.
      ...(Object.keys(settings.terminalColorOverrides ?? {}).length > 0
        ? { terminalColorOverrides: undefined }
        : {})
    },
    terminalThemes
  )
}

/**
 * Applies a plugin's themes right after the user installs or enables it, so the change is
 * visible at once, and offers one click back. Only for clicks; never updates or startup.
 * A light and a dark theme fill both slots; a single theme fills its own mode's slot and
 * switches the app to that mode, since most themes ship one mode and must still show.
 */
export async function applyPluginThemesNow(pluginKey: string): Promise<boolean> {
  const [apps, icons, terminals] = await Promise.all([
    usePluginThemeStore.getState().fetchEntries(),
    usePluginIconThemeStore.getState().fetchEntries(),
    usePluginTerminalThemeStore.getState().fetchEntries()
  ])
  const { settings, updateSettings } = useAppStore.getState()
  const own = <T extends { pluginKey: string }>(list: readonly T[]): T[] =>
    list.filter((entry) => entry.pluginKey === pluginKey)
  const ownApps = own(apps)
  const icon = own(icons)[0]
  const ownTerminals = own(terminals)
  if (!settings || (ownApps.length === 0 && !icon && ownTerminals.length === 0)) {
    return false
  }
  const currentlyDark = resolveDocumentTheme(settings.theme)
  const appFor = (base: 'light' | 'dark'): PluginThemeRegistration | undefined =>
    ownApps.find((theme) => theme.base === base)
  const appSlots = [appFor('light'), appFor('dark')].filter((theme) => theme !== undefined)
  // Why: with one app theme, the app shows that theme's mode once applied.
  const dark = appSlots.length === 1 ? appSlots[0].base === 'dark' : currentlyDark
  const terminalFor = (mode: 'light' | 'dark'): PluginTerminalThemeRegistration | undefined =>
    ownTerminals.find((theme) => theme.mode === mode)
  const terminalPicks = [terminalFor('light'), terminalFor('dark')].filter(
    (theme) => theme !== undefined
  )
  if (terminalPicks.length === 0 && ownTerminals[0]) {
    terminalPicks.push(ownTerminals[0])
  }
  const shownMode = dark ? 'dark' : 'light'
  if (terminalPicks.length === 1 && terminalPicks[0].mode !== shownMode) {
    // Why: a lone terminal theme for the other mode would fill a slot nobody sees right now.
    terminalPicks[0] = { ...terminalPicks[0], mode: 'unknown' }
  }
  // Why null, not undefined: an absent key would not overwrite what this apply set.
  const previous: Partial<GlobalSettings> = {
    theme: settings.theme,
    pluginAppThemeLight: settings.pluginAppThemeLight ?? null,
    pluginAppThemeDark: settings.pluginAppThemeDark ?? null,
    pluginIconTheme: settings.pluginIconTheme ?? null,
    terminalThemeDark: settings.terminalThemeDark,
    terminalThemeLight: settings.terminalThemeLight,
    terminalUseSeparateLightTheme: settings.terminalUseSeparateLightTheme,
    terminalColorOverrides: settings.terminalColorOverrides,
    terminalPluginPalettes: settings.terminalPluginPalettes ?? []
  }
  let next: Partial<GlobalSettings> = {}
  for (const theme of appSlots) {
    next = { ...next, ...pluginAppThemeSlotUpdate(theme.base, theme.id) }
  }
  if (dark !== currentlyDark) {
    next.theme = dark ? 'dark' : 'light'
  }
  next = { ...next, ...(icon ? { pluginIconTheme: icon.id } : {}) }
  for (const theme of terminalPicks) {
    next = { ...next, ...terminalThemeUpdate({ ...settings, ...next }, theme, dark, terminals) }
  }
  await updateSettings(next)
  const shown = appSlots.find((theme) => (theme.base === 'dark') === dark)
  const label = (shown ?? icon ?? terminalPicks[0])?.label ?? ''
  toast.success(
    translate('auto.components.settings.pluginThemeApply.nowUsing', 'Now using {{value0}}', {
      value0: label
    }),
    {
      duration: PLUGIN_ACTION_TOAST_DURATION_MS,
      action: {
        label: translate('auto.components.settings.pluginThemeApply.switchBack', 'Switch back'),
        onClick: () => void useAppStore.getState().updateSettings(previous)
      }
    }
  )
  return true
}
