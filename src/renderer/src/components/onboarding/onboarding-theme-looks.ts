import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  completePluginAppThemeTokens,
  type PluginThemeRegistration
} from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import { resolveTerminalPalette } from '../../../../shared/terminal-themes/terminal-theme-selection'
import { TERMINAL_THEME_CATALOG } from '../../../../shared/terminal-themes/terminal-theme-catalog'

export type ThemeLookBase = 'light' | 'dark'

export type ThemeLookPalette = {
  background: string
  sidebar: string
  foreground: string
  mutedForeground: string
  border: string
  accent: string
  primary: string
  terminal: {
    background: string
    foreground: string
    muted: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
  }
}

export type ThemeLook = {
  id: string
  label: string
  /** Who made it, shown as the card's caption. */
  source: string
  base: ThemeLookBase
  palette: ThemeLookPalette
} & (
  | { kind: 'built-in' }
  | {
      kind: 'plugin'
      theme: PluginThemeRegistration
      terminal: PluginTerminalThemeRegistration | null
    }
  | { kind: 'terminal'; terminalThemeName: string }
)

// Popular community palettes Orca ships; Match Terminal turns each into a whole-app theme.
const TERMINAL_LOOKS: Record<ThemeLookBase, readonly string[]> = {
  dark: [
    'Catppuccin Mocha',
    'Tokyo Night',
    'Dracula',
    'Rose Pine',
    'Gruvbox Dark',
    'One Dark',
    'Everforest Dark',
    'Night Owl',
    'Solarized Dark'
  ],
  light: [
    'Catppuccin Latte',
    'Rose Pine Dawn',
    'Tokyo Night Light',
    'Gruvbox Light',
    'One Light',
    'Everforest Light',
    'Solarized Light'
  ]
}

// Why literal colors: previews show main.css's built-in tokens while the other mode is painted.
const BUILT_IN_CHROME: Record<ThemeLookBase, Omit<ThemeLookPalette, 'terminal'>> = {
  dark: {
    background: '#0a0a0a',
    sidebar: '#171717',
    foreground: '#f0f0f0',
    mutedForeground: '#acacac',
    border: 'rgb(255 255 255 / 0.07)',
    accent: '#2a2a2a',
    primary: '#e5e5e5'
  },
  light: {
    background: '#ffffff',
    sidebar: '#fafafa',
    foreground: '#0a0a0a',
    mutedForeground: '#696969',
    border: '#e5e5e5',
    accent: '#f0f0f0',
    primary: '#171717'
  }
}

export function builtInThemeLookId(base: ThemeLookBase): string {
  return `built-in:${base}`
}

function terminalLookId(name: string): string {
  return `terminal:${name}`
}

function mixInto(color: string, background: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${background})`
}

function terminalPalette(theme: ITheme | null | undefined): ThemeLookPalette['terminal'] | null {
  if (!theme?.background || !theme.foreground) {
    return null
  }
  const { background, foreground } = theme
  return {
    background,
    foreground,
    muted: theme.brightBlack ?? mixInto(foreground, background, 55),
    red: theme.red ?? foreground,
    green: theme.green ?? foreground,
    yellow: theme.yellow ?? foreground,
    blue: theme.blue ?? foreground,
    magenta: theme.magenta ?? foreground,
    cyan: theme.cyan ?? foreground
  }
}

/** The terminal a slot shows today, so built-in looks preview the user's own terminal colors. */
function currentTerminal(
  settings: GlobalSettings,
  base: ThemeLookBase
): ThemeLookPalette['terminal'] {
  const fallback =
    TERMINAL_THEME_CATALOG[base === 'dark' ? 'Ghostty Default Style Dark' : 'Builtin Tango Light']
  return (
    terminalPalette(resolveTerminalPalette({ ...settings, theme: base }, base === 'dark').theme) ??
    terminalPalette(fallback)!
  )
}

function pluginTerminalFor(
  theme: PluginThemeRegistration,
  terminals: readonly PluginTerminalThemeRegistration[]
): PluginTerminalThemeRegistration | null {
  const own = terminals.filter(
    (terminal) =>
      terminal.pluginKey === theme.pluginKey &&
      (terminal.mode === theme.base || terminal.mode === 'unknown')
  )
  return (
    own.find((terminal) => terminal.label === theme.label) ?? (own.length === 1 ? own[0] : null)
  )
}

function pluginLook(
  theme: PluginThemeRegistration,
  terminals: readonly PluginTerminalThemeRegistration[],
  baseline: GlobalSettings
): ThemeLook {
  const tokens = completePluginAppThemeTokens(theme.tokens)
  const terminal = pluginTerminalFor(theme, terminals)
  return {
    kind: 'plugin',
    id: theme.id,
    label: theme.label,
    source: theme.pluginName,
    base: theme.base,
    theme,
    terminal,
    palette: {
      background: tokens['--background'],
      sidebar: tokens['--worktree-sidebar'] ?? tokens['--sidebar'] ?? tokens['--background'],
      foreground: tokens['--foreground'],
      mutedForeground: tokens['--muted-foreground'] ?? tokens['--foreground'],
      border: tokens['--border'] ?? mixInto(tokens['--foreground'], tokens['--background'], 16),
      accent: tokens['--accent'] ?? mixInto(tokens['--foreground'], tokens['--background'], 12),
      primary: tokens['--primary'] ?? tokens['--foreground'],
      terminal: terminalPalette(terminal?.terminal) ?? currentTerminal(baseline, theme.base)
    }
  }
}

function terminalLook(name: string, base: ThemeLookBase, source: string): ThemeLook | null {
  const terminal = terminalPalette(TERMINAL_THEME_CATALOG[name])
  if (!terminal) {
    return null
  }
  const { background, foreground } = terminal
  return {
    kind: 'terminal',
    id: terminalLookId(name),
    label: name,
    source,
    base,
    terminalThemeName: name,
    palette: {
      background,
      // Why equal: Match Terminal paints the sidebar with the terminal background.
      sidebar: background,
      foreground,
      mutedForeground: mixInto(foreground, background, 70),
      border: mixInto(foreground, background, 10),
      accent: mixInto(foreground, background, 12),
      primary: terminal.blue,
      terminal
    }
  }
}

/** Every look the theme step offers for one mode: Orca's own first, then installed plugin
 *  themes, then popular terminal palettes painted through Match Terminal. */
export function buildThemeLooks(options: {
  base: ThemeLookBase
  pluginThemes: readonly PluginThemeRegistration[]
  pluginTerminalThemes: readonly PluginTerminalThemeRegistration[]
  baseline: GlobalSettings
  labels: { orca: string; builtIn: (base: ThemeLookBase) => string; community: string }
}): ThemeLook[] {
  const { base, pluginThemes, pluginTerminalThemes, baseline, labels } = options
  const builtIn: ThemeLook = {
    kind: 'built-in',
    id: builtInThemeLookId(base),
    label: labels.builtIn(base),
    source: labels.orca,
    base,
    palette: { ...BUILT_IN_CHROME[base], terminal: currentTerminal(baseline, base) }
  }
  const plugins = pluginThemes
    .filter((theme) => theme.base === base)
    .map((theme) => pluginLook(theme, pluginTerminalThemes, baseline))
  const terminals = TERMINAL_LOOKS[base].flatMap(
    (name) => terminalLook(name, base, labels.community) ?? []
  )
  return [builtIn, ...plugins, ...terminals]
}
