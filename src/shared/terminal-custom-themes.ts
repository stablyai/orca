import type { ITheme } from '@xterm/xterm'
import type { TerminalColorOverrides } from './types'
import { HEX_COLOR_RE } from './color-validation'

export type TerminalCustomThemeSource = 'warp' | 'ghostty' | 'manual'
export type TerminalCustomThemeMode = 'dark' | 'light' | 'unknown'

export type TerminalCustomTheme = {
  id: string
  name: string
  source: TerminalCustomThemeSource
  mode: TerminalCustomThemeMode
  terminal: TerminalColorOverrides
  importedAt: string
  sourceLabel?: string
  unsupportedFeatures?: string[]
}

export type TerminalThemeSelection = string

export type WarpThemeImportSource =
  | { kind: 'auto' }
  | { kind: 'chooseFile' }
  | { kind: 'chooseFolder' }

export type WarpThemeImportPreviewTheme = TerminalCustomTheme & {
  selectionValue: string
}

export type WarpThemeImportSkippedFile = {
  label: string
  reason: string
}

export type WarpThemeImportPreview = {
  found: boolean
  /** True when the user dismissed the native picker without selecting anything. */
  canceled?: boolean
  desktopOnly?: boolean
  sourceLabel?: string
  themes: WarpThemeImportPreviewTheme[]
  skippedFiles: WarpThemeImportSkippedFile[]
  error?: string
}

export const MAX_TERMINAL_CUSTOM_THEMES = 200
export const CUSTOM_TERMINAL_THEME_PREFIX = 'custom:'

const TERMINAL_COLOR_KEYS = [
  'foreground',
  'background',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
  'bold'
] as const satisfies readonly (keyof TerminalColorOverrides)[]

const TERMINAL_ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const satisfies readonly (keyof TerminalColorOverrides)[]

export function makeCustomTerminalThemeSelection(id: string): string {
  return `${CUSTOM_TERMINAL_THEME_PREFIX}${id}`
}

export function parseCustomTerminalThemeSelection(selection: string): string | null {
  return selection.startsWith(CUSTOM_TERMINAL_THEME_PREFIX)
    ? selection.slice(CUSTOM_TERMINAL_THEME_PREFIX.length)
    : null
}

function removeControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
}

export function normalizeTerminalThemeId(value: unknown, fallback = 'theme'): string {
  const raw = typeof value === 'string' ? value : fallback
  const normalized = removeControlCharacters(raw)
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

export function normalizeTerminalThemeName(value: unknown, fallback = 'Imported Theme'): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const normalized = removeControlCharacters(value)
    .replace(/[\\/]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return normalized || fallback
}

export function normalizeTerminalHexColor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!HEX_COLOR_RE.test(trimmed)) {
    return null
  }
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  const expanded =
    withoutHash.length === 3
      ? withoutHash
          .split('')
          .map((character) => `${character}${character}`)
          .join('')
      : withoutHash
  return `#${expanded.toLowerCase()}`
}

export function normalizeTerminalColorOverrides(value: unknown): TerminalColorOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const input = value as Record<string, unknown>
  const output: TerminalColorOverrides = {}
  for (const key of TERMINAL_COLOR_KEYS) {
    const color = normalizeTerminalHexColor(input[key])
    if (color) {
      output[key] = color
    }
  }
  return output
}

export function hasUsableTerminalThemeColors(terminal: TerminalColorOverrides): boolean {
  const ansiCount = TERMINAL_ANSI_COLOR_KEYS.filter((key) => terminal[key]).length
  return Boolean(terminal.background && terminal.foreground && ansiCount > 0)
}

function normalizeSource(value: unknown): TerminalCustomThemeSource {
  return value === 'warp' || value === 'ghostty' || value === 'manual' ? value : 'manual'
}

function normalizeMode(value: unknown): TerminalCustomThemeMode {
  return value === 'dark' || value === 'light' || value === 'unknown' ? value : 'unknown'
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return normalized.length > 0 ? [...new Set(normalized)] : undefined
}

export function normalizeTerminalCustomThemes(value: unknown): TerminalCustomTheme[] {
  if (!Array.isArray(value)) {
    return []
  }

  const byId = new Map<string, TerminalCustomTheme>()
  for (const entry of value.slice(-MAX_TERMINAL_CUSTOM_THEMES)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }
    const input = entry as Record<string, unknown>
    const source = normalizeSource(input.source)
    const name = normalizeTerminalThemeName(input.name)
    const idBase = normalizeTerminalThemeId(input.id ?? `${source}:${name}`)
    const id = idBase.includes(':') ? idBase : `${source}:${idBase}`
    const terminal = normalizeTerminalColorOverrides(input.terminal)
    if (!id || !name || !hasUsableTerminalThemeColors(terminal)) {
      continue
    }
    const importedAt =
      typeof input.importedAt === 'string' && input.importedAt.trim()
        ? input.importedAt
        : new Date(0).toISOString()
    byId.set(id, {
      id,
      name,
      source,
      mode: normalizeMode(input.mode),
      terminal,
      importedAt,
      ...(typeof input.sourceLabel === 'string' && input.sourceLabel.trim()
        ? { sourceLabel: input.sourceLabel.trim() }
        : {}),
      ...(normalizeStringArray(input.unsupportedFeatures)
        ? { unsupportedFeatures: normalizeStringArray(input.unsupportedFeatures) }
        : {})
    })
  }

  return [...byId.values()].slice(-MAX_TERMINAL_CUSTOM_THEMES)
}

export function terminalCustomThemeToXtermTheme(theme: TerminalCustomTheme): ITheme {
  return { ...theme.terminal }
}
