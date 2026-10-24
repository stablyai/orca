import type { TerminalPluginPalette } from './terminal-color-overrides'

/** Appearance choices that come from plugins. */
export type PluginAppearanceSettings = {
  /** A plugin theme's id; its colors replace the built-in ones and its base picks light or dark. */
  pluginAppTheme?: `plugin:${string}` | null
  /** The built-in choice to return to when the plugin theme is off or removed. */
  themeBeforePlugin?: 'system' | 'dark' | 'light' | null
  /** A plugin icon theme's id for file and folder icons; null keeps the built-in icons. */
  pluginIconTheme?: `plugin:${string}` | null
  /** Palettes of the selected plugin terminal themes, so main, headless serve and relays
   *  resolve them without the plugin loaded. Only selected themes are kept. */
  terminalPluginPalettes?: TerminalPluginPalette[]
}
