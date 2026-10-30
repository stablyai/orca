import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TerminalPluginPalette } from '../../../shared/terminal-color-overrides'
import type { PluginTerminalThemeRegistration } from '../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'

type PaletteSettings = Pick<
  GlobalSettings,
  'terminalThemeDark' | 'terminalThemeLight' | 'terminalPluginPalettes'
>

function selectedPalettes(
  dark: string,
  light: string,
  current: readonly TerminalPluginPalette[],
  pluginThemes: readonly PluginTerminalThemeRegistration[]
): TerminalPluginPalette[] {
  return [...new Set([dark, light])].flatMap((selection) => {
    const theme = pluginThemes.find((candidate) => candidate.id === selection)
    // Why keep the old snapshot: re-enabling a disabled plugin restores the palette it chose.
    const palette = theme
      ? { id: theme.id, colors: theme.terminal }
      : current.find((entry) => entry.id === selection)
    return palette ? [palette] : []
  })
}

/** Adds the palette snapshot a terminal theme selection needs, so every host resolves it. */
export function withTerminalPluginPalettes(
  settings: PaletteSettings,
  update: Partial<GlobalSettings>,
  pluginThemes: readonly PluginTerminalThemeRegistration[]
): Partial<GlobalSettings> {
  const current = settings.terminalPluginPalettes ?? []
  const dark = update.terminalThemeDark ?? settings.terminalThemeDark
  const light = update.terminalThemeLight ?? settings.terminalThemeLight
  // Why: users who never pick a plugin theme keep their settings writes unchanged.
  if (current.length === 0 && !dark.startsWith('plugin:') && !light.startsWith('plugin:')) {
    return update
  }
  return { ...update, terminalPluginPalettes: selectedPalettes(dark, light, current, pluginThemes) }
}

/** The snapshot refresh after a plugin updates a selected palette, or null when nothing changed. */
export function refreshedTerminalPluginPalettes(
  settings: PaletteSettings,
  pluginThemes: readonly PluginTerminalThemeRegistration[]
): Partial<GlobalSettings> | null {
  const next = withTerminalPluginPalettes(settings, {}, pluginThemes)
  return !next.terminalPluginPalettes ||
    JSON.stringify(next.terminalPluginPalettes) ===
      JSON.stringify(settings.terminalPluginPalettes ?? [])
    ? null
    : next
}
