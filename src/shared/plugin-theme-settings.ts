import type { GlobalSettings } from './global-settings-types'
import type { TerminalPluginPalette } from './terminal-color-overrides'
import {
  hasUsableTerminalThemeColors,
  normalizeTerminalColorOverrides
} from './terminal-custom-themes'

type PluginThemeSettings = Pick<
  GlobalSettings,
  | 'pluginAppTheme'
  | 'pluginAppThemeLight'
  | 'pluginAppThemeDark'
  | 'pluginIconTheme'
  | 'themeBeforePlugin'
  | 'terminalPluginPalettes'
>

/** The setting that holds the plugin app theme for one light/dark mode. */
export function pluginAppThemeSlotUpdate(
  base: 'light' | 'dark',
  id: `plugin:${string}` | null
): Pick<GlobalSettings, 'pluginAppThemeLight'> | Pick<GlobalSettings, 'pluginAppThemeDark'> {
  return base === 'dark' ? { pluginAppThemeDark: id } : { pluginAppThemeLight: id }
}

// Two terminal slots (dark, light) can each hold one plugin palette.
const MAX_TERMINAL_PLUGIN_PALETTES = 2
const PLUGIN_CONTENT_ID =
  /^plugin:[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/

function contentId(value: unknown): `plugin:${string}` | null {
  return typeof value === 'string' && PLUGIN_CONTENT_ID.test(value)
    ? `plugin:${value.slice('plugin:'.length)}`
    : null
}

function palettes(value: unknown): TerminalPluginPalette[] {
  if (!Array.isArray(value)) {
    return []
  }
  const result: TerminalPluginPalette[] = []
  for (const entry of value) {
    const id =
      typeof entry === 'object' && entry !== null && 'id' in entry ? contentId(entry.id) : null
    const colors = normalizeTerminalColorOverrides(
      typeof entry === 'object' && entry !== null && 'colors' in entry ? entry.colors : undefined
    )
    if (id && hasUsableTerminalThemeColors(colors) && !result.some((p) => p.id === id)) {
      result.push({ id, colors })
    }
  }
  return result.slice(0, MAX_TERMINAL_PLUGIN_PALETTES)
}

/** Unvalidated plugin theme keys as a settings write or load carries them. */
export type PluginThemeSettingsInput = { [Key in keyof PluginThemeSettings]?: unknown }

/** Bounds plugin theme settings on every write and load; only keys present in `input` return. */
export function normalizePluginThemeSettings(
  input: PluginThemeSettingsInput
): Partial<PluginThemeSettings> {
  const result: Partial<PluginThemeSettings> = {}
  if ('pluginAppTheme' in input) {
    result.pluginAppTheme = contentId(input.pluginAppTheme)
  }
  if ('pluginAppThemeLight' in input) {
    result.pluginAppThemeLight = contentId(input.pluginAppThemeLight)
  }
  if ('pluginAppThemeDark' in input) {
    result.pluginAppThemeDark = contentId(input.pluginAppThemeDark)
  }
  if ('pluginIconTheme' in input) {
    result.pluginIconTheme = contentId(input.pluginIconTheme)
  }
  if ('themeBeforePlugin' in input) {
    const theme = input.themeBeforePlugin
    result.themeBeforePlugin =
      theme === 'system' || theme === 'dark' || theme === 'light' ? theme : null
  }
  if ('terminalPluginPalettes' in input) {
    result.terminalPluginPalettes = palettes(input.terminalPluginPalettes)
  }
  return result
}

function ownedBy(id: string | null | undefined, pluginKey: string): boolean {
  return typeof id === 'string' && id.startsWith(`plugin:${pluginKey}/`)
}

/** Forgets an uninstalled plugin's theme choices so a reinstall does not quietly reapply them. */
export function pluginThemeSettingsAfterRemoval(
  settings: Pick<
    GlobalSettings,
    | 'theme'
    | 'terminalThemeDark'
    | 'terminalThemeLight'
    | 'pluginAppTheme'
    | 'pluginAppThemeLight'
    | 'pluginAppThemeDark'
    | 'pluginIconTheme'
    | 'themeBeforePlugin'
    | 'terminalPluginPalettes'
  >,
  pluginKey: string
): Partial<GlobalSettings> {
  const update: Partial<GlobalSettings> = {}
  if (ownedBy(settings.pluginAppTheme, pluginKey)) {
    update.pluginAppTheme = null
    update.themeBeforePlugin = null
    update.theme = settings.themeBeforePlugin ?? settings.theme
  }
  if (ownedBy(settings.pluginAppThemeLight, pluginKey)) {
    update.pluginAppThemeLight = null
  }
  if (ownedBy(settings.pluginAppThemeDark, pluginKey)) {
    update.pluginAppThemeDark = null
  }
  if (ownedBy(settings.pluginIconTheme, pluginKey)) {
    update.pluginIconTheme = null
  }
  if (ownedBy(settings.terminalThemeDark, pluginKey)) {
    update.terminalThemeDark = ''
  }
  if (ownedBy(settings.terminalThemeLight, pluginKey)) {
    update.terminalThemeLight = ''
  }
  const kept = (settings.terminalPluginPalettes ?? []).filter((p) => !ownedBy(p.id, pluginKey))
  if (kept.length !== (settings.terminalPluginPalettes ?? []).length) {
    update.terminalPluginPalettes = kept
  }
  return update
}
