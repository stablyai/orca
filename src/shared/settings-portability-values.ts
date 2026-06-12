import type {
  CommitMessageAiSettings,
  GlobalSettings,
  NotificationSettings,
  TerminalColorOverrides
} from './types'
import type { SourceControlAiSettings } from './source-control-ai-types'
import type { VoiceSettings } from './speech-types'
import { getDefaultSettings } from './constants'
import { PORTABLE_STRING_ENUM_VALUES } from './settings-portability-keys'
import { normalizeTerminalQuickCommands } from './terminal-quick-commands'
import { normalizeDisabledTuiAgents } from './tui-agent-selection'
import { isTuiAgent } from './tui-agent-config'
import { sanitizeCommitMessageAi, sanitizeSourceControlAi } from './settings-portability-ai-values'

const DEFAULT_SETTINGS_FOR_IMPORT_VALIDATION = getDefaultSettings('')
const TERMINAL_COLOR_OVERRIDE_KEYS = [
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
const NOTIFICATION_SOUND_IDS = [
  'system',
  'two-tone',
  'bong',
  'thump',
  'blip',
  'sonar',
  'blop',
  'ding',
  'clack',
  'beep',
  'custom'
] as const satisfies readonly NotificationSettings['customSoundId'][]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sanitizePortableNotifications(value: NotificationSettings): NotificationSettings {
  return {
    enabled: value.enabled,
    agentTaskComplete: value.agentTaskComplete,
    terminalBell: value.terminalBell,
    suppressWhenFocused: value.suppressWhenFocused,
    // Why: custom notification sounds are local filesystem paths and often do
    // not exist on another machine, so the portable export keeps the setting
    // shape while falling back to Orca's bundled system sound.
    customSoundId: value.customSoundId === 'custom' ? 'system' : value.customSoundId,
    customSoundPath: null,
    customSoundVolume: value.customSoundVolume
  }
}

function sanitizePortableVoice(value: VoiceSettings): VoiceSettings {
  return {
    enabled: value.enabled,
    sttModel: value.sttModel,
    // Why: model directories and user model entries are machine-local paths,
    // and OpenAI keys live in encrypted local storage rather than exports.
    modelsDir: '',
    language: value.language,
    dictationMode: value.dictationMode,
    terminalConfirmBeforeInsert: value.terminalConfirmBeforeInsert,
    userModels: [],
    openAiApiKeyConfigured: false
  }
}

function isSafeRecordKey(key: string): boolean {
  return key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSafeRecordKey(key) && typeof item === 'string') {
      result[key] = item
    }
  }
  return result
}

function sanitizeAgentStringRecord(value: unknown): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {}
  for (const [key, item] of Object.entries(sanitizeStringRecord(value))) {
    if (isTuiAgent(key)) {
      result[key] = item
    }
  }
  return result
}

function sanitizeTerminalColorOverrides(value: unknown): TerminalColorOverrides {
  if (!isPlainObject(value)) {
    return {}
  }
  const result: TerminalColorOverrides = {}
  for (const key of TERMINAL_COLOR_OVERRIDE_KEYS) {
    const color = value[key]
    if (typeof color === 'string') {
      result[key] = color
    }
  }
  return result
}

function sanitizeTerminalQuickCommands(
  value: unknown
): ReturnType<typeof normalizeTerminalQuickCommands> {
  return normalizeTerminalQuickCommands(value).filter((command) => {
    const scope = command.scope
    return !scope || scope.type === 'global'
  })
}

export function sanitizePortableSettingValue(key: keyof GlobalSettings, value: unknown): unknown {
  if (key === 'notifications') {
    return sanitizePortableNotifications(value as NotificationSettings)
  }
  if (key === 'voice') {
    return sanitizePortableVoice(value as VoiceSettings)
  }
  if (key === 'terminalColorOverrides') {
    return sanitizeTerminalColorOverrides(value)
  }
  if (key === 'terminalQuickCommands') {
    return sanitizeTerminalQuickCommands(value)
  }
  if (key === 'disabledTuiAgents') {
    return normalizeDisabledTuiAgents(value)
  }
  if (key === 'agentCmdOverrides') {
    return sanitizeAgentStringRecord(value)
  }
  if (key === 'commitMessageAi') {
    return sanitizeCommitMessageAi(value as CommitMessageAiSettings)
  }
  if (key === 'sourceControlAi') {
    return sanitizeSourceControlAi(value as SourceControlAiSettings)
  }
  return cloneJsonValue(value)
}

function isSupportedPortableVoiceValue(value: unknown): value is VoiceSettings {
  if (!isPlainObject(value)) {
    return false
  }
  return (
    typeof value.enabled === 'boolean' &&
    typeof value.sttModel === 'string' &&
    typeof value.modelsDir === 'string' &&
    typeof value.language === 'string' &&
    (value.dictationMode === 'toggle' || value.dictationMode === 'hold') &&
    typeof value.terminalConfirmBeforeInsert === 'boolean' &&
    Array.isArray(value.userModels) &&
    typeof value.openAiApiKeyConfigured === 'boolean'
  )
}

function isSupportedPortableNotificationValue(value: unknown): value is NotificationSettings {
  if (!isPlainObject(value)) {
    return false
  }
  return (
    typeof value.enabled === 'boolean' &&
    typeof value.agentTaskComplete === 'boolean' &&
    typeof value.terminalBell === 'boolean' &&
    typeof value.suppressWhenFocused === 'boolean' &&
    typeof value.customSoundId === 'string' &&
    NOTIFICATION_SOUND_IDS.includes(value.customSoundId as NotificationSettings['customSoundId']) &&
    (typeof value.customSoundPath === 'string' || value.customSoundPath === null) &&
    typeof value.customSoundVolume === 'number' &&
    Number.isFinite(value.customSoundVolume)
  )
}

function hasMatchingDefaultType(key: keyof GlobalSettings, value: unknown): boolean {
  const defaultValue = DEFAULT_SETTINGS_FOR_IMPORT_VALIDATION[key]
  if (defaultValue === undefined) {
    return true
  }
  if (defaultValue === null) {
    if (key === 'mobileAutoRestoreFitMs') {
      return value === null || (typeof value === 'number' && Number.isFinite(value))
    }
    if (key === 'defaultTuiAgent') {
      return value === null || typeof value === 'string'
    }
    return value === null
  }
  if (Array.isArray(defaultValue)) {
    return Array.isArray(value)
  }
  if (typeof defaultValue === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
  }
  if (typeof defaultValue === 'boolean') {
    return typeof value === 'boolean'
  }
  if (typeof defaultValue === 'string') {
    return typeof value === 'string'
  }
  if (typeof defaultValue === 'object') {
    return isPlainObject(value)
  }
  return false
}

export function isSupportedPortableSettingValue(
  key: keyof GlobalSettings,
  value: unknown
): boolean {
  if (key === 'voice') {
    return isSupportedPortableVoiceValue(value)
  }
  if (key === 'notifications') {
    return isSupportedPortableNotificationValue(value)
  }
  const enumValues = PORTABLE_STRING_ENUM_VALUES[key]
  if (enumValues) {
    return typeof value === 'string' && enumValues.includes(value)
  }
  return hasMatchingDefaultType(key, value)
}
