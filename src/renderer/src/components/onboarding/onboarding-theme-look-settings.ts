import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PluginTerminalThemeRegistration } from '../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import {
  MATCH_TERMINAL_APP_THEME,
  pluginAppThemeSlotUpdate
} from '../../../../shared/plugin-theme-settings'
import {
  hasTerminalColorOverrides,
  TERMINAL_COLOR_OVERRIDES_SETTING
} from '../../../../shared/terminal-themes/terminal-color-overrides'
import { withTerminalPluginPalettes } from '@/lib/terminal-plugin-palettes'
import { terminalThemeUpdate } from '../plugins/state/plugin-theme-apply'
import { builtInThemeLookId, type ThemeLook, type ThemeLookBase } from './onboarding-theme-looks'

/** Settings a look writes; the rest of GlobalSettings is never touched by a pick. */
export type ThemeLookSettings = Pick<
  GlobalSettings,
  | 'theme'
  | 'pluginAppThemeDark'
  | 'pluginAppThemeLight'
  | 'terminalThemeDark'
  | 'terminalThemeLight'
  | 'terminalUseSeparateLightTheme'
  | 'terminalColorOverrides'
  | 'terminalColorOverridesLight'
  | 'terminalPluginPalettes'
>

function slotTerminalTheme(settings: ThemeLookSettings, base: ThemeLookBase): string {
  return base === 'dark' || !settings.terminalUseSeparateLightTheme
    ? settings.terminalThemeDark
    : settings.terminalThemeLight
}

/** The look a mode's slot holds now, or null when it holds something the step doesn't offer. */
export function selectedThemeLookId(
  settings: ThemeLookSettings,
  base: ThemeLookBase,
  looks: readonly ThemeLook[]
): string | null {
  const app = base === 'dark' ? settings.pluginAppThemeDark : settings.pluginAppThemeLight
  if (!app) {
    return builtInThemeLookId(base)
  }
  if (app === MATCH_TERMINAL_APP_THEME) {
    const name = slotTerminalTheme(settings, base)
    return (
      looks.find((look) => look.kind === 'terminal' && look.terminalThemeName === name)?.id ?? null
    )
  }
  return looks.find((look) => look.kind === 'plugin' && look.id === app)?.id ?? null
}

/** One mode's look settings as they were, so a new pick replaces the last one cleanly. */
function slotBaseline(baseline: ThemeLookSettings, base: ThemeLookBase): Partial<GlobalSettings> {
  return base === 'dark'
    ? {
        pluginAppThemeDark: baseline.pluginAppThemeDark ?? null,
        terminalThemeDark: baseline.terminalThemeDark,
        terminalColorOverrides: baseline.terminalColorOverrides
      }
    : {
        pluginAppThemeLight: baseline.pluginAppThemeLight ?? null,
        terminalThemeLight: baseline.terminalThemeLight,
        terminalUseSeparateLightTheme: baseline.terminalUseSeparateLightTheme,
        terminalColorOverridesLight: baseline.terminalColorOverridesLight
      }
}

/** The settings write for picking a look: that mode's slot only, starting from the baseline. */
export function themeLookSettingsUpdate(
  look: ThemeLook,
  settings: GlobalSettings,
  baseline: ThemeLookSettings,
  pluginTerminalThemes: readonly PluginTerminalThemeRegistration[]
): Partial<GlobalSettings> {
  const dark = look.base === 'dark'
  let next: Partial<GlobalSettings> = slotBaseline(baseline, look.base)
  if (look.kind === 'built-in') {
    next = { ...next, ...pluginAppThemeSlotUpdate(look.base, null) }
  } else if (look.kind === 'plugin') {
    next = { ...next, ...pluginAppThemeSlotUpdate(look.base, look.theme.id) }
    if (look.terminal) {
      next = {
        ...next,
        ...terminalThemeUpdate({ ...settings, ...next }, look.terminal, dark, pluginTerminalThemes)
      }
    }
  } else {
    const merged = { ...settings, ...next }
    next = {
      ...next,
      ...pluginAppThemeSlotUpdate(look.base, MATCH_TERMINAL_APP_THEME),
      ...(dark
        ? { terminalThemeDark: look.terminalThemeName }
        : { terminalThemeLight: look.terminalThemeName, terminalUseSeparateLightTheme: true }),
      // A picked palette must replace its slot's overrides or they mask its colors.
      ...(hasTerminalColorOverrides(merged, look.base)
        ? { [TERMINAL_COLOR_OVERRIDES_SETTING[look.base]]: undefined }
        : {})
    }
  }
  return withTerminalPluginPalettes({ ...settings, ...next }, next, pluginTerminalThemes)
}

export function captureThemeLookSettings(settings: GlobalSettings): ThemeLookSettings {
  return {
    theme: settings.theme,
    pluginAppThemeDark: settings.pluginAppThemeDark ?? null,
    pluginAppThemeLight: settings.pluginAppThemeLight ?? null,
    terminalThemeDark: settings.terminalThemeDark,
    terminalThemeLight: settings.terminalThemeLight,
    terminalUseSeparateLightTheme: settings.terminalUseSeparateLightTheme,
    terminalColorOverrides: settings.terminalColorOverrides,
    terminalColorOverridesLight: settings.terminalColorOverridesLight,
    terminalPluginPalettes: settings.terminalPluginPalettes ?? []
  }
}
