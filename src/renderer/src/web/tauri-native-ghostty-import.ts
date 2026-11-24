// Ghostty config import preview, renderer-side for Tauri.
//
// Electron main reads %APPDATA%\ghostty\* and maps the parsed keys through
// mapGhosttyToOrca. Tauri keeps the same parse/map pair but reads the config
// files through the authorized-external staging channel instead of a direct
// fs handle, since the renderer has no ambient fs. Theme references resolve
// the same way: Windows has no named Ghostty theme dirs, so only absolute
// `theme = <path>` references merge.

import type { SettingsApi } from '../../../preload/api/preferences/settings-api'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'

type GhosttyImportPreview = Awaited<ReturnType<SettingsApi['previewGhosttyImport']>>
import { parseGhosttyConfig } from '../../../main/ghostty/parser'
import { mapGhosttyToOrca } from '../../../main/ghostty/mapper'
import { readStagedFileText, stagePath } from './tauri-native-staged-read'

const MAX_CONFIG_BYTES = 1_000_000
const MAX_THEME_BYTES = 262_144

type ParsedConfig = Record<string, string | string[]>

function configCandidates(): string[] {
  const appData =
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WebView2 exposes no process env; fall back to the same %APPDATA% shape Electron resolves on Windows.
    ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.APPDATA as string | undefined) ?? ''
  const base = appData || 'C:\\Users\\Default\\AppData\\Roaming'
  const dir = `${base}\\ghostty`
  return [`${dir}\\config.ghostty`, `${dir}\\config`]
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function mergeParsed(target: ParsedConfig, parsed: ParsedConfig): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'palette') {
      target[key] = [...asArray(target[key]), ...asArray(value)]
      continue
    }
    target[key] = value
  }
}

// Why public API: the preview only compares terminal keys, so it reads them
// through the settings API that owns focus routing instead of the store reader.
function currentTerminalDiffBase(): Partial<GlobalSettings> {
  return window.api.settings.getSync() ?? {}
}

function usesConditionalThemePair(themeName: string): boolean {
  return themeName
    .split(',')
    .map((part) => part.trim())
    .some((part) => part.startsWith('light:') || part.startsWith('dark:'))
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

async function applyThemeReference(parsed: ParsedConfig): Promise<string[]> {
  const rawTheme = parsed['theme']
  if (rawTheme === undefined) {
    return []
  }
  delete parsed['theme']

  const themeName = (Array.isArray(rawTheme) ? (rawTheme.at(-1) ?? '') : rawTheme).trim()
  if (usesConditionalThemePair(themeName)) {
    return ['theme (light:/dark: pairs not supported)']
  }
  if (!isAbsolutePath(themeName)) {
    return ['theme (theme file not found)']
  }

  const staged = await stagePath(themeName)
  if (staged.source.status !== 'staged' || !staged.file) {
    return ['theme (theme file not found)']
  }
  let content: string
  try {
    content = await readStagedFileText(themeName, staged.file, MAX_THEME_BYTES)
  } catch {
    return ['theme (theme file not found)']
  }
  const themeColors = parseGhosttyConfig(content)
  for (const [key, value] of Object.entries(themeColors)) {
    if (key === 'palette') {
      parsed[key] = [...asArray(value), ...asArray(parsed[key])]
    } else if (parsed[key] === undefined) {
      parsed[key] = value
    }
  }
  return []
}

export async function previewTauriGhosttyImport(): Promise<GhosttyImportPreview> {
  const parsed: ParsedConfig = {}
  const readPaths: string[] = []
  let firstError: string | null = null
  for (const configPath of configCandidates()) {
    const staged = await stagePath(configPath)
    if (staged.source.status !== 'staged' || !staged.file) {
      continue
    }
    try {
      const content = await readStagedFileText(configPath, staged.file, MAX_CONFIG_BYTES)
      mergeParsed(parsed, parseGhosttyConfig(content))
      readPaths.push(configPath)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read config file'
      if (firstError === null) {
        firstError = `Could not read config: ${message}`
      }
    }
  }

  if (readPaths.length === 0) {
    return {
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: firstError ?? 'Could not read config'
    }
  }

  const themeUnsupportedKeys = await applyThemeReference(parsed)
  const { diff: rawDiff, unsupportedKeys: mappedUnsupportedKeys } = mapGhosttyToOrca(parsed, false)
  const unsupportedKeys = [...mappedUnsupportedKeys, ...themeUnsupportedKeys]

  const currentSettings = currentTerminalDiffBase()
  const actualDiff: Partial<typeof rawDiff> = {}
  for (const key of Object.keys(rawDiff) as (keyof typeof rawDiff)[]) {
    const value = rawDiff[key]
    if (value !== undefined && !valuesEqual(currentSettings[key], value)) {
      // Why: TypeScript strict assignment for Partial<T>[K] requires a cast
      // because GlobalSettings has no index signature.
      ;(actualDiff as Record<string, unknown>)[key] = value
    }
  }

  return {
    found: true,
    configPath: readPaths[0],
    configPaths: readPaths,
    diff: actualDiff,
    unsupportedKeys
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) {
    return `[${v.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(v as Record<string, unknown>).sort(([ka], [kb]) =>
    ka.localeCompare(kb)
  )
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return stableStringify(a) === stableStringify(b)
  }
  return false
}
