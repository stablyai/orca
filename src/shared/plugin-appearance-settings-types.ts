import type { TerminalPluginPalette } from './terminal-color-overrides'

/** A code editor theme: a plugin app theme of either base, or the built-in light or dark colors. */
export type CodeEditorThemeChoice = 'light' | 'dark' | `plugin:${string}`

/** An app theme slot's source: a plugin theme's id, or colors derived from the active terminal theme. */
export type AppThemeSlotSelection = `plugin:${string}` | 'match-terminal'

/** Appearance choices that come from plugins. */
export type PluginAppearanceSettings = {
  /** App theme painted while Orca is light; null keeps the built-in colors. */
  pluginAppThemeLight?: AppThemeSlotSelection | null
  /** App theme painted while Orca is dark; null keeps the built-in colors. */
  pluginAppThemeDark?: AppThemeSlotSelection | null
  /** Code editor colors while Orca is light; null follows the app theme. */
  editorThemeLight?: CodeEditorThemeChoice | null
  /** Code editor colors while Orca is dark; null follows the app theme. */
  editorThemeDark?: CodeEditorThemeChoice | null
  /** Legacy single choice; moved into the slot of its theme's base once that theme loads. */
  pluginAppTheme?: `plugin:${string}` | null
  /** Legacy companion of `pluginAppTheme`; cleared by the same migration. */
  themeBeforePlugin?: 'system' | 'dark' | 'light' | null
  /** A plugin icon theme's id for file and folder icons; null keeps the built-in icons. */
  pluginIconTheme?: `plugin:${string}` | null
  /** Palettes of the selected plugin terminal themes, so main, headless serve and relays
   *  resolve them without the plugin loaded. Only selected themes are kept. */
  terminalPluginPalettes?: TerminalPluginPalette[]
}
