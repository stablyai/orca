import type { CodexMicroControlId } from './codex-micro-types'
import { CODEX_MICRO_CONTROL_IDS } from './codex-micro-types'
import type { KeybindingActionId } from './keybindings'
import { isKeybindingActionId } from './keybindings'

export type CodexMicroDialMode = 'navigate' | 'scroll'

export type CodexMicroSettings = {
  enabled: boolean
  lightingEnabled: boolean
  brightness: number
  idleTimeoutSeconds: number
  mappings: Partial<Record<CodexMicroControlId, KeybindingActionId>>
  dialMode: CodexMicroDialMode
}

export const CODEX_MICRO_BRIGHTNESS_MIN = 0
export const CODEX_MICRO_BRIGHTNESS_MAX = 100
export const CODEX_MICRO_IDLE_TIMEOUT_SECONDS_MIN = 10
export const CODEX_MICRO_IDLE_TIMEOUT_SECONDS_MAX = 3600

const CONTROL_ID_SET = new Set<string>(CODEX_MICRO_CONTROL_IDS)

export const DEFAULT_CODEX_MICRO_SETTINGS: CodexMicroSettings = {
  enabled: false,
  lightingEnabled: false,
  brightness: 100,
  idleTimeoutSeconds: 300,
  dialMode: 'navigate',
  mappings: {
    AG00: 'worktree.navigateUp',
    AG01: 'worktree.navigateDown',
    ACT06: 'worktree.history.back',
    ACT07: 'worktree.history.forward',
    ACT08: 'sidebar.left.toggle',
    ENC_CC: 'tab.previousRecent',
    ENC_CW: 'tab.nextAllTypes',
    ENC_CLK: 'worktree.palette'
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeBrightness(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, CODEX_MICRO_BRIGHTNESS_MIN, CODEX_MICRO_BRIGHTNESS_MAX)
    : DEFAULT_CODEX_MICRO_SETTINGS.brightness
}

function normalizeIdleTimeoutSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, CODEX_MICRO_IDLE_TIMEOUT_SECONDS_MIN, CODEX_MICRO_IDLE_TIMEOUT_SECONDS_MAX)
    : DEFAULT_CODEX_MICRO_SETTINGS.idleTimeoutSeconds
}

function normalizeDialMode(value: unknown): CodexMicroDialMode {
  return value === 'navigate' || value === 'scroll' ? value : DEFAULT_CODEX_MICRO_SETTINGS.dialMode
}

// Explicit mappings input (even with unassigned/invalid entries) always wins
// over defaults, so a user un-mapping a control never gets it silently
// re-filled on the next settings:set round-trip.
function normalizeMappings(
  value: unknown
): Partial<Record<CodexMicroControlId, KeybindingActionId>> {
  if (!isPlainRecord(value)) {
    return { ...DEFAULT_CODEX_MICRO_SETTINGS.mappings }
  }
  const result: Partial<Record<CodexMicroControlId, KeybindingActionId>> = {}
  for (const [control, actionId] of Object.entries(value)) {
    if (!CONTROL_ID_SET.has(control)) {
      continue
    }
    if (typeof actionId !== 'string' || !isKeybindingActionId(actionId)) {
      continue
    }
    result[control as CodexMicroControlId] = actionId
  }
  return result
}

export function normalizeCodexMicroSettings(value: unknown): CodexMicroSettings {
  if (!isPlainRecord(value)) {
    return {
      ...DEFAULT_CODEX_MICRO_SETTINGS,
      mappings: { ...DEFAULT_CODEX_MICRO_SETTINGS.mappings }
    }
  }
  return {
    enabled: normalizeBoolean(value.enabled, DEFAULT_CODEX_MICRO_SETTINGS.enabled),
    lightingEnabled: normalizeBoolean(
      value.lightingEnabled,
      DEFAULT_CODEX_MICRO_SETTINGS.lightingEnabled
    ),
    brightness: normalizeBrightness(value.brightness),
    idleTimeoutSeconds: normalizeIdleTimeoutSeconds(value.idleTimeoutSeconds),
    dialMode: normalizeDialMode(value.dialMode),
    mappings: normalizeMappings(value.mappings)
  }
}
