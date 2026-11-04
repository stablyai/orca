import type { GlobalSettings } from './global-settings-types'
import type {
  AppThemeSlotSelection,
  CodeEditorThemeChoice
} from './plugin-appearance-settings-types'
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
  | 'editorThemeLight'
  | 'editorThemeDark'
  | 'pluginIconTheme'
  | 'themeBeforePlugin'
  | 'terminalPluginPalettes'
>

/** The app theme slot value that paints Orca from the active terminal theme's colors. */
export const MATCH_TERMINAL_APP_THEME = 'match-terminal' satisfies AppThemeSlotSelection

/** The setting that holds the app theme for one light/dark mode. */
export function pluginAppThemeSlotUpdate(
  base: 'light' | 'dark',
  id: AppThemeSlotSelection | null
): Pick<GlobalSettings, 'pluginAppThemeLight'> | Pick<GlobalSettings, 'pluginAppThemeDark'> {
  return base === 'dark' ? { pluginAppThemeDark: id } : { pluginAppThemeLight: id }
}

/** The setting that holds the code editor theme for one light/dark mode. */
export function editorThemeSlotUpdate(
  base: 'light' | 'dark',
  choice: CodeEditorThemeChoice | null
): Pick<GlobalSettings, 'editorThemeLight'> | Pick<GlobalSettings, 'editorThemeDark'> {
  return base === 'dark' ? { editorThemeDark: choice } : { editorThemeLight: choice }
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

function editorThemeChoice(value: unknown): CodeEditorThemeChoice | null {
  return value === 'light' || value === 'dark' ? value : contentId(value)
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

function appThemeSlot(value: unknown): AppThemeSlotSelection | null {
  return value === MATCH_TERMINAL_APP_THEME ? MATCH_TERMINAL_APP_THEME : contentId(value)
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
    result.pluginAppThemeLight = appThemeSlot(input.pluginAppThemeLight)
  }
  if ('pluginAppThemeDark' in input) {
    result.pluginAppThemeDark = appThemeSlot(input.pluginAppThemeDark)
  }
  if ('editorThemeLight' in input) {
    result.editorThemeLight = editorThemeChoice(input.editorThemeLight)
  }
  if ('editorThemeDark' in input) {
    result.editorThemeDark = editorThemeChoice(input.editorThemeDark)
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

type MatchTerminalSidebarSettings = Partial<
  Pick<GlobalSettings, 'pluginAppThemeLight' | 'pluginAppThemeDark' | 'leftSidebarAppearanceMode'>
>

/** Whether stored settings carry the sidebar value from before the app theme slots existed (or
 *  from an older Orca that cleared the slots it didn't understand). */
export function hasLegacyMatchTerminalSidebar(settings: MatchTerminalSidebarSettings): boolean {
  return (
    settings.leftSidebarAppearanceMode === 'match-terminal' &&
    settings.pluginAppThemeLight !== MATCH_TERMINAL_APP_THEME &&
    settings.pluginAppThemeDark !== MATCH_TERMINAL_APP_THEME
  )
}

/**
 * Keeps the sidebar's "Match Terminal" value in step with the app theme slots. Older Orca only
 * reads the sidebar value, so it is written while a slot matches the terminal; a legacy write of
 * it fills the empty slots, and a slot holding a plugin theme keeps it.
 */
export function syncLegacyMatchTerminalSidebar(
  settings: MatchTerminalSidebarSettings,
  legacyWrite: boolean
): Required<MatchTerminalSidebarSettings> {
  const slot = (value: AppThemeSlotSelection | null | undefined): AppThemeSlotSelection | null =>
    value ?? (legacyWrite ? MATCH_TERMINAL_APP_THEME : null)
  const pluginAppThemeLight = slot(settings.pluginAppThemeLight)
  const pluginAppThemeDark = slot(settings.pluginAppThemeDark)
  const matches =
    pluginAppThemeLight === MATCH_TERMINAL_APP_THEME ||
    pluginAppThemeDark === MATCH_TERMINAL_APP_THEME
  return {
    pluginAppThemeLight,
    pluginAppThemeDark,
    leftSidebarAppearanceMode:
      settings.leftSidebarAppearanceMode === 'tinted'
        ? 'tinted'
        : matches
          ? 'match-terminal'
          : 'default'
  }
}

/** The settings write that keeps the sidebar value in step; empty when it touches neither. */
export function legacyMatchTerminalSidebarWrite(
  current: MatchTerminalSidebarSettings,
  updates: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  if (
    !('pluginAppThemeLight' in updates) &&
    !('pluginAppThemeDark' in updates) &&
    !('leftSidebarAppearanceMode' in updates)
  ) {
    return {}
  }
  // Why slots absent: a full-settings write carries the mirror next to the slots it chose.
  const legacyWrite =
    updates.leftSidebarAppearanceMode === 'match-terminal' &&
    !('pluginAppThemeLight' in updates) &&
    !('pluginAppThemeDark' in updates)
  return syncLegacyMatchTerminalSidebar({ ...current, ...updates }, legacyWrite)
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
    | 'editorThemeLight'
    | 'editorThemeDark'
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
  if (ownedBy(settings.editorThemeLight, pluginKey)) {
    update.editorThemeLight = null
  }
  if (ownedBy(settings.editorThemeDark, pluginKey)) {
    update.editorThemeDark = null
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
