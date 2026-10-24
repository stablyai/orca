import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PluginThemeRegistration } from '../../../../shared/plugins/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../../../shared/plugins/plugin-terminal-theme-artifact'
import { translate } from '@/i18n/i18n'
import { applyDocumentTheme, resolveDocumentTheme } from '@/lib/document-theme'
import { withTerminalPluginPalettes } from '@/lib/terminal-plugin-palettes'
import { useAppStore } from '@/store'
import { usePluginIconThemeStore } from '@/store/plugin-icon-themes'
import { usePluginThemeStore, usePluginTerminalThemeStore } from '@/store/plugin-themes'

export function appThemeUpdate(
  settings: GlobalSettings,
  theme: PluginThemeRegistration
): Partial<GlobalSettings> {
  return {
    theme: theme.base,
    pluginAppTheme: theme.id,
    // Why keep the first one: switching between plugin themes must not lose it.
    themeBeforePlugin: settings.themeBeforePlugin ?? settings.theme
  }
}

export function terminalSlot(
  mode: PluginTerminalThemeRegistration['mode'],
  dark: boolean
): 'terminalThemeDark' | 'terminalThemeLight' {
  return mode === 'light' || (mode === 'unknown' && !dark)
    ? 'terminalThemeLight'
    : 'terminalThemeDark'
}

export function terminalThemeUpdate(
  settings: GlobalSettings,
  theme: PluginTerminalThemeRegistration,
  dark: boolean,
  terminalThemes: readonly PluginTerminalThemeRegistration[]
): Partial<GlobalSettings> {
  const slot = terminalSlot(theme.mode, dark)
  return withTerminalPluginPalettes(
    settings,
    {
      [slot]: theme.id,
      ...(slot === 'terminalThemeLight' ? { terminalUseSeparateLightTheme: true } : {})
    },
    terminalThemes
  )
}

/**
 * Applies a plugin's themes right after the user installs or enables it, so the change is
 * visible at once, and offers one click back. Only for clicks; never updates or startup.
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
  const app =
    ownApps.find((theme) => (theme.base === 'dark') === currentlyDark) ?? ownApps[0] ?? null
  const dark = app ? app.base === 'dark' : currentlyDark
  const want = dark ? 'dark' : 'light'
  const terminal =
    ownTerminals.find((theme) => theme.mode === want) ??
    ownTerminals.find((theme) => theme.mode === 'unknown') ??
    ownTerminals[0] ??
    null
  // Why null, not undefined: an absent key would not overwrite what this apply set.
  const previous: Partial<GlobalSettings> = {
    theme: settings.theme,
    pluginAppTheme: settings.pluginAppTheme ?? null,
    themeBeforePlugin: settings.themeBeforePlugin ?? null,
    pluginIconTheme: settings.pluginIconTheme ?? null,
    terminalThemeDark: settings.terminalThemeDark,
    terminalThemeLight: settings.terminalThemeLight,
    terminalUseSeparateLightTheme: settings.terminalUseSeparateLightTheme,
    terminalPluginPalettes: settings.terminalPluginPalettes ?? []
  }
  await updateSettings({
    ...(app ? appThemeUpdate(settings, app) : {}),
    ...(icon ? { pluginIconTheme: icon.id } : {}),
    ...(terminal ? terminalThemeUpdate(settings, terminal, dark, terminals) : {})
  })
  if (app) {
    applyDocumentTheme(app.base)
  }
  toast.success(
    translate('auto.components.settings.pluginThemeApply.nowUsing', 'Now using {{value0}}', {
      value0: (app ?? icon ?? terminal)?.label ?? ''
    }),
    {
      action: {
        label: translate('auto.components.settings.pluginThemeApply.switchBack', 'Switch back'),
        onClick: () => {
          void useAppStore.getState().updateSettings(previous)
          applyDocumentTheme(settings.theme)
        }
      }
    }
  )
  return true
}
