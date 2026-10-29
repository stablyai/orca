import type { TerminalPluginPalette } from './terminal-color-overrides'

/** Appearance choices that come from plugins. */
export type PluginAppearanceSettings = {
  /** Plugin theme painted while Orca is light; null keeps the built-in colors. */
  pluginAppThemeLight?: `plugin:${string}` | null
  /** Plugin theme painted while Orca is dark; null keeps the built-in colors. */
  pluginAppThemeDark?: `plugin:${string}` | null
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
