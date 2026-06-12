import type { GlobalSettings } from './types'
import { PORTABLE_SETTINGS_KEYS } from './settings-portability-keys'
import {
  isSupportedPortableSettingValue,
  sanitizePortableSettingValue
} from './settings-portability-values'

export const SETTINGS_EXPORT_FORMAT_VERSION = 1
export const SETTINGS_EXPORT_KIND = 'orca-settings-export'

export type SettingsExportDocument = {
  kind: typeof SETTINGS_EXPORT_KIND
  version: typeof SETTINGS_EXPORT_FORMAT_VERSION
  exportedAt: string
  settings: Partial<GlobalSettings>
  keybindings?: unknown
}

export type SettingsImportPreview = {
  ok: boolean
  cancelled?: boolean
  filePath?: string
  portableSettingCount: number
  changedSettingKeys: string[]
  skippedSettingKeys: string[]
  includesKeybindings: boolean
  changedKeybindings: boolean
  error?: string
}

export type SettingsExportResult =
  | { success: true; filePath: string; portableSettingCount: number; includesKeybindings: boolean }
  | { success: false; cancelled?: boolean; error?: string }

export type SettingsImportResult =
  | {
      success: true
      portableSettingCount: number
      skippedSettingKeys: string[]
      includesKeybindings: boolean
    }
  | { success: false; error?: string }

const PORTABLE_SETTINGS_KEY_SET = new Set<string>(PORTABLE_SETTINGS_KEYS)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// Why: hand-edited or differently-ordered export files must not read as
// "changed" when the values match, so comparisons sort object keys first.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (isPlainObject(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')
    return `{${body}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isGlobalQuickCommand(value: unknown): boolean {
  return isPlainObject(value) && (!isPlainObject(value.scope) || value.scope.type === 'global')
}

function hasStringId(value: unknown): value is { id: string } {
  return isPlainObject(value) && typeof value.id === 'string'
}

function mergeTerminalQuickCommandsForImport(value: unknown, current: unknown): unknown {
  if (!Array.isArray(value)) {
    return value
  }
  if (!Array.isArray(current)) {
    return value
  }
  const incomingGlobals = value.filter(isGlobalQuickCommand)
  const incomingById = new Map(
    incomingGlobals.filter(hasStringId).map((command) => [command.id, command])
  )
  const seenIncomingIds = new Set<string>()
  const merged = current.flatMap((command) => {
    if (!isGlobalQuickCommand(command)) {
      return [command]
    }
    if (!hasStringId(command)) {
      return []
    }
    const incoming = incomingById.get(command.id)
    if (!incoming) {
      return []
    }
    seenIncomingIds.add(command.id)
    return [incoming]
  })
  for (const command of incomingGlobals) {
    if (!hasStringId(command) || !seenIncomingIds.has(command.id)) {
      merged.push(command)
    }
  }
  return merged
}

function withDefinedProperty(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  if (source[key] !== undefined) {
    target[key] = source[key]
  }
  return target
}

function mergeVoiceForImport(value: unknown, current: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(current)) {
    return value
  }
  const merged = {
    ...value,
    // Why: voice model directories, custom models, and OpenAI key state are
    // machine-local. Imports should not erase them on the target machine.
    modelsDir: current.modelsDir,
    userModels: current.userModels,
    openAiApiKeyConfigured: current.openAiApiKeyConfigured
  }
  return withDefinedProperty(merged, current, 'openAiApiKey')
}

function mergeNotificationsForImport(value: unknown, current: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(current)) {
    return value
  }
  if (
    current.customSoundId === 'custom' &&
    value.customSoundId === 'system' &&
    value.customSoundPath === null
  ) {
    // Why: custom sound paths are intentionally not portable. Preserve an
    // existing local custom sound instead of turning export-then-import into a
    // destructive local-path reset.
    return {
      ...value,
      customSoundId: current.customSoundId,
      customSoundPath: current.customSoundPath
    }
  }
  return value
}

function mergePortableSettingForImport(
  key: keyof GlobalSettings,
  value: unknown,
  currentSettings: Partial<GlobalSettings>
): unknown {
  const current = currentSettings[key]
  if (key === 'terminalQuickCommands') {
    return mergeTerminalQuickCommandsForImport(value, current)
  }
  if (key === 'voice') {
    return mergeVoiceForImport(value, current)
  }
  if (key === 'notifications') {
    return mergeNotificationsForImport(value, current)
  }
  return value
}

function getComparableCurrentPortableSetting(
  key: keyof GlobalSettings,
  currentSettings: Partial<GlobalSettings>
): unknown {
  const current = currentSettings[key]
  if (current === undefined || !isSupportedPortableSettingValue(key, current)) {
    return current
  }
  const sanitized = sanitizePortableSettingValue(key, current)
  return mergePortableSettingForImport(key, sanitized, currentSettings)
}

export function createSettingsExportDocument(
  settings: GlobalSettings,
  options: { keybindings?: unknown; exportedAt?: string } = {}
): SettingsExportDocument {
  const exportedSettings: Partial<GlobalSettings> = {}
  for (const key of PORTABLE_SETTINGS_KEYS) {
    if (!(key in settings)) {
      continue
    }
    const value = settings[key]
    if (value === undefined) {
      continue
    }
    ;(exportedSettings as Record<string, unknown>)[key] = sanitizePortableSettingValue(key, value)
  }

  return {
    kind: SETTINGS_EXPORT_KIND,
    version: SETTINGS_EXPORT_FORMAT_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    settings: exportedSettings,
    ...(options.keybindings !== undefined
      ? { keybindings: cloneJsonValue(options.keybindings) }
      : {})
  }
}

export function readSettingsExportDocument(input: unknown): {
  document?: SettingsExportDocument
  error?: string
} {
  if (!isPlainObject(input)) {
    return { error: 'Settings export must contain a JSON object.' }
  }
  if (input.kind !== SETTINGS_EXPORT_KIND || input.version !== SETTINGS_EXPORT_FORMAT_VERSION) {
    return { error: 'This file is not a supported Orca settings export.' }
  }
  if (!isPlainObject(input.settings)) {
    return { error: 'Settings export is missing a settings object.' }
  }
  if (typeof input.exportedAt !== 'string') {
    return { error: 'Settings export is missing an exportedAt timestamp.' }
  }
  return { document: input as SettingsExportDocument }
}

export function getPortableSettingsFromExport(
  document: SettingsExportDocument,
  currentSettings: Partial<GlobalSettings> = {}
): {
  settings: Partial<GlobalSettings>
  skippedSettingKeys: string[]
} {
  const settings: Partial<GlobalSettings> = {}
  const skippedSettingKeys: string[] = []
  for (const [key, value] of Object.entries(document.settings)) {
    if (!PORTABLE_SETTINGS_KEY_SET.has(key)) {
      skippedSettingKeys.push(key)
      continue
    }
    const settingKey = key as keyof GlobalSettings
    if (value === undefined) {
      continue
    }
    if (!isSupportedPortableSettingValue(settingKey, value)) {
      if (stableStringify(value) !== stableStringify(currentSettings[settingKey])) {
        skippedSettingKeys.push(key)
      }
      continue
    }
    const sanitized = sanitizePortableSettingValue(settingKey, value)
    ;(settings as Record<string, unknown>)[key] = mergePortableSettingForImport(
      settingKey,
      sanitized,
      currentSettings
    )
  }
  return { settings, skippedSettingKeys }
}

export function previewSettingsExportImport(
  input: unknown,
  currentSettings: Partial<GlobalSettings>,
  options: { currentKeybindings?: unknown } = {}
): SettingsImportPreview {
  const parsed = readSettingsExportDocument(input)
  if (!parsed.document) {
    return {
      ok: false,
      portableSettingCount: 0,
      changedSettingKeys: [],
      skippedSettingKeys: [],
      includesKeybindings: false,
      changedKeybindings: false,
      error: parsed.error
    }
  }
  const portable = getPortableSettingsFromExport(parsed.document, currentSettings)
  const changedSettingKeys = Object.entries(portable.settings)
    .filter(([key, value]) => {
      const current = getComparableCurrentPortableSetting(
        key as keyof GlobalSettings,
        currentSettings
      )
      return stableStringify(value) !== stableStringify(current)
    })
    .map(([key]) => key)
  return {
    ok: true,
    portableSettingCount: Object.keys(portable.settings).length,
    changedSettingKeys,
    skippedSettingKeys: portable.skippedSettingKeys,
    includesKeybindings: parsed.document.keybindings !== undefined,
    changedKeybindings:
      parsed.document.keybindings !== undefined &&
      stableStringify(parsed.document.keybindings) !== stableStringify(options.currentKeybindings)
  }
}
