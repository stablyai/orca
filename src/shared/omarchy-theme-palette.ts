import type { GlobalSettings } from './global-settings-types'
import type { TerminalColorOverrides } from './terminal-color-overrides'
import {
  makeCustomTerminalThemeSelection,
  type TerminalCustomTheme
} from './terminal-custom-themes'

// Seed keys rendered by omarchy/orca.json.tpl; every one must be a #rrggbb hex.
export const OMARCHY_SEED_COLOR_KEYS = [
  'background',
  'dark_background',
  'darker_background',
  'lighter_background',
  'foreground',
  'dark_foreground',
  'bright_foreground',
  'muted',
  'accent',
  'selection',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'color0',
  'color1',
  'color2',
  'color3',
  'color4',
  'color5',
  'color6',
  'color7',
  'color8',
  'color9',
  'color10',
  'color11',
  'color12',
  'color13',
  'color14',
  'color15',
  'terminal_cursor',
  'terminal_selection'
] as const

export type OmarchySeedColorKey = (typeof OMARCHY_SEED_COLOR_KEYS)[number]

export type OmarchyThemeSeed = { mode: 'dark' | 'light' } & Record<OmarchySeedColorKey, string>

export type OmarchyThemePalette = {
  seed: OmarchyThemeSeed
  cssVars: Record<string, string>
}

export const OMARCHY_TERMINAL_THEME_ID = 'omarchy:live'
export const OMARCHY_TERMINAL_THEME_SELECTION =
  makeCustomTerminalThemeSelection(OMARCHY_TERMINAL_THEME_ID)

const STRICT_HEX_RE = /^#[0-9a-fA-F]{6}$/

/** Parses rendered orca.json text; null when unresolved, malformed, or incomplete. */
export function parseOmarchyThemeSeed(text: string): OmarchyThemeSeed | null {
  // Omarchy leaves `{{ key }}` in place when a theme lacks that color.
  if (text.includes('{{')) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !isOmarchyThemeSeed(raw)) {
    return null
  }
  const seed: OmarchyThemeSeed = { ...raw }
  for (const key of OMARCHY_SEED_COLOR_KEYS) {
    seed[key] = seed[key].toLowerCase()
  }
  return seed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOmarchyThemeSeed(value: Record<string, unknown>): value is OmarchyThemeSeed {
  return (
    (value.mode === 'dark' || value.mode === 'light') &&
    OMARCHY_SEED_COLOR_KEYS.every((key) => {
      const color = value[key]
      return typeof color === 'string' && STRICT_HEX_RE.test(color)
    })
  )
}

function mix(color: string, percent: number, base: string): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${base})`
}

function alpha(color: string, percent: number): string {
  return mix(color, percent, 'transparent')
}

/** Maps the Omarchy seed onto Orca's themable CSS variables (never --orca-security-* or layout vars). */
export function deriveOmarchyCssVars(seed: OmarchyThemeSeed): Record<string, string> {
  const dark = seed.mode === 'dark'
  const bg = seed.background
  const fg = seed.foreground
  const sidebarBg = seed.dark_background
  const surface = mix(fg, 4, bg)
  const hover = mix(fg, 10, bg)
  const border = alpha(fg, dark ? 9 : 12)
  const chatCanvas = dark ? mix(fg, 5, bg) : bg
  const titleFamily = dark ? 'on-dark' : 'on-light'

  return {
    '--background': bg,
    '--foreground': fg,
    '--card': surface,
    '--card-foreground': fg,
    '--popover': surface,
    '--popover-foreground': fg,
    '--primary': seed.accent,
    '--primary-foreground': bg,
    '--secondary': seed.lighter_background,
    '--secondary-foreground': fg,
    '--muted': seed.lighter_background,
    '--muted-foreground': seed.dark_foreground,
    '--accent': hover,
    '--accent-foreground': fg,
    '--border': border,
    '--input': alpha(fg, dark ? 15 : 20),
    '--ring': seed.muted,
    '--destructive': seed.red,
    '--destructive-foreground': bg,
    '--editor-surface': bg,

    '--sidebar': sidebarBg,
    '--sidebar-foreground': fg,
    '--sidebar-primary': seed.accent,
    '--sidebar-primary-foreground': bg,
    '--sidebar-accent': mix(fg, 8, sidebarBg),
    '--sidebar-accent-foreground': fg,
    '--sidebar-border': border,
    '--sidebar-ring': seed.muted,
    '--worktree-sidebar': sidebarBg,
    '--worktree-sidebar-foreground': fg,
    '--worktree-sidebar-accent': seed.selection,
    '--worktree-sidebar-accent-foreground': seed.bright_foreground,
    '--worktree-sidebar-border': border,
    '--worktree-sidebar-ring': seed.muted,

    '--chat-canvas': chatCanvas,
    '--chat-foreground': mix(fg, dark ? 78 : 82, chatCanvas),
    '--chat-foreground-strong': mix(fg, dark ? 90 : 92, chatCanvas),
    '--chat-foreground-faint': mix(seed.dark_foreground, 83, chatCanvas),
    '--chat-user-surface': mix(fg, dark ? 7 : 4, chatCanvas),
    '--chat-user-border': alpha(fg, dark ? 6 : 7),
    '--chat-code-foreground': mix(fg, 85, chatCanvas),
    '--chat-code-surface': mix(fg, dark ? 3.5 : 2, chatCanvas),
    '--chat-code-border': alpha(fg, 7),
    '--chat-inline-code-surface': mix(fg, dark ? 6 : 4, chatCanvas),
    '--chat-inline-code-border': alpha(fg, dark ? 8 : 9),
    '--chat-composer-surface': dark ? mix(fg, 4, chatCanvas) : chatCanvas,
    '--chat-composer-border': alpha(fg, dark ? 9 : 11),

    '--git-decoration-added': seed.green,
    '--git-decoration-modified': seed.yellow,
    '--git-decoration-deleted': seed.red,
    '--git-decoration-renamed': seed.blue,
    '--git-decoration-untracked': seed.cyan,
    '--git-decoration-copied': seed.blue,
    '--git-decoration-ignored': seed.muted,
    '--diff-added-ground': mix(seed.green, dark ? 16 : 13, bg),
    '--diff-added-gutter': mix(seed.green, dark ? 30 : 26, bg),
    '--diff-removed-ground': mix(seed.red, dark ? 18 : 11, bg),
    '--diff-removed-gutter': mix(seed.red, dark ? 32 : 22, bg),
    '--git-graph-lane-1': seed.accent,
    '--git-graph-lane-2': seed.cyan,
    '--git-graph-lane-3': seed.blue,
    '--git-graph-lane-4': seed.magenta,
    '--git-graph-lane-5': seed.yellow,

    '--status-success': seed.green,
    '--status-success-background': alpha(seed.green, 10),
    '--status-success-border': alpha(seed.green, 25),
    '--status-warning': seed.yellow,
    '--status-warning-background': alpha(seed.yellow, 10),
    '--status-warning-border': alpha(seed.yellow, 25),
    '--workspace-status-done': seed.magenta,
    '--workspace-status-review': seed.green,
    '--workspace-status-progress': seed.yellow,
    '--chart-1': seed.accent,
    '--chart-2': seed.blue,
    '--chart-3': seed.cyan,
    '--chart-4': seed.magenta,
    '--chart-5': seed.green,

    // Only the family matching the palette's mode; the other keeps its stock contrast.
    [`--terminal-pane-title-${titleFamily}-fg`]: alpha(fg, dark ? 52 : 64),
    [`--terminal-pane-title-${titleFamily}-input-fg`]: alpha(fg, dark ? 70 : 82),
    [`--terminal-pane-title-${titleFamily}-placeholder`]: alpha(fg, dark ? 38 : 48),
    [`--terminal-pane-title-${titleFamily}-button-fg`]: seed.bright_foreground,
    [`--terminal-pane-title-${titleFamily}-button-hover-fg`]: seed.bright_foreground,
    [`--terminal-pane-title-${titleFamily}-input-bg`]: alpha(fg, dark ? 4 : 5),
    [`--terminal-pane-title-${titleFamily}-separator`]: alpha(fg, dark ? 6 : 10)
  }
}

export function deriveOmarchyPalette(seed: OmarchyThemeSeed): OmarchyThemePalette {
  return { seed, cssVars: deriveOmarchyCssVars(seed) }
}

export function deriveOmarchyTerminalColors(seed: OmarchyThemeSeed): TerminalColorOverrides {
  return {
    background: seed.background,
    foreground: seed.foreground,
    cursor: seed.terminal_cursor,
    cursorAccent: seed.background,
    selectionBackground: seed.terminal_selection,
    selectionForeground: seed.bright_foreground,
    black: seed.color0,
    red: seed.color1,
    green: seed.color2,
    yellow: seed.color3,
    blue: seed.color4,
    magenta: seed.color5,
    cyan: seed.color6,
    white: seed.color7,
    brightBlack: seed.color8,
    brightRed: seed.color9,
    brightGreen: seed.color10,
    brightYellow: seed.color11,
    brightBlue: seed.color12,
    brightMagenta: seed.color13,
    brightCyan: seed.color14,
    brightWhite: seed.color15
  }
}

/** Monaco only accepts #rrggbb / #rrggbbaa, so alpha tints append a hex alpha byte. */
export function deriveOmarchyMonacoColors(seed: OmarchyThemeSeed): Record<string, string> {
  return {
    'editor.background': seed.background,
    'editor.foreground': seed.foreground,
    'editorGutter.background': seed.background,
    'editorCursor.foreground': seed.terminal_cursor,
    'editor.selectionBackground': seed.selection,
    'editor.lineHighlightBackground': `${seed.lighter_background}80`,
    'editorLineNumber.foreground': seed.muted,
    'editorLineNumber.activeForeground': seed.dark_foreground,
    'editorWidget.background': seed.dark_background,
    'editorWidget.border': seed.muted,
    'editorIndentGuide.background1': `${seed.muted}55`,
    'diffEditor.insertedTextBackground': `${seed.green}33`,
    'diffEditor.removedTextBackground': `${seed.red}33`,
    'diffEditor.insertedLineBackground': `${seed.green}22`,
    'diffEditor.removedLineBackground': `${seed.red}22`
  }
}

export function isOmarchyTerminalThemeSelected(
  settings: Pick<
    GlobalSettings,
    'terminalThemeDark' | 'terminalThemeLight' | 'terminalUseSeparateLightTheme'
  >
): boolean {
  return (
    settings.terminalThemeDark === OMARCHY_TERMINAL_THEME_SELECTION ||
    (settings.terminalUseSeparateLightTheme &&
      settings.terminalThemeLight === OMARCHY_TERMINAL_THEME_SELECTION)
  )
}

/** Custom-theme list with the live Omarchy entry refreshed; null when already current. */
export function upsertOmarchyTerminalTheme(
  themes: readonly TerminalCustomTheme[] | undefined,
  seed: OmarchyThemeSeed
): TerminalCustomTheme[] | null {
  const terminal = deriveOmarchyTerminalColors(seed)
  const existing = themes?.find((theme) => theme.id === OMARCHY_TERMINAL_THEME_ID)
  if (
    existing &&
    existing.mode === seed.mode &&
    JSON.stringify(existing.terminal) === JSON.stringify(terminal)
  ) {
    return null
  }
  const entry: TerminalCustomTheme = {
    id: OMARCHY_TERMINAL_THEME_ID,
    name: 'Omarchy',
    source: 'omarchy',
    mode: seed.mode,
    terminal,
    importedAt: new Date().toISOString()
  }
  return [...(themes ?? []).filter((theme) => theme.id !== OMARCHY_TERMINAL_THEME_ID), entry]
}
