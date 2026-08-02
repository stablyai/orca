export type CodexMicroConnectionState =
  | { kind: 'disabled' | 'disconnected' | 'connecting' }
  | { kind: 'connected'; firmware: 'v0.4.1'; battery?: number; charging?: boolean }
  | { kind: 'read-only'; firmware: string | null; reason: 'unknown-firmware' }
  | { kind: 'conflict' | 'permission-error' | 'error'; code: string; message: string }

export type CodexMicroControlId =
  | 'AG00'
  | 'AG01'
  | 'AG02'
  | 'AG03'
  | 'AG04'
  | 'AG05'
  | 'ACT06'
  | 'ACT07'
  | 'ACT08'
  | 'ACT09'
  | 'ACT10'
  | 'ACT11'
  | 'ACT12'
  | 'ENC_CC'
  | 'ENC_CW'
  | 'ENC_CLK'

export type CodexMicroInputEvent =
  | { kind: 'control'; control: CodexMicroControlId; action: 0 | 1 | 2 }
  | { kind: 'radar'; angle: number; distance: number }

export const CODEX_MICRO_CONTROL_IDS: readonly CodexMicroControlId[] = [
  'AG00',
  'AG01',
  'AG02',
  'AG03',
  'AG04',
  'AG05',
  'ACT06',
  'ACT07',
  'ACT08',
  'ACT09',
  'ACT10',
  'ACT11',
  'ACT12',
  'ENC_CC',
  'ENC_CW',
  'ENC_CLK'
]

export const CODEX_MICRO_MAPPABLE_CONTROL_IDS = CODEX_MICRO_CONTROL_IDS.filter(
  (control) => control !== 'ACT11'
)

const CONTROL_ID_SET = new Set<string>(CODEX_MICRO_CONTROL_IDS)
const ENCODER_ROTATION_CONTROLS = new Set<string>(['ENC_CC', 'ENC_CW'])

export function isCodexMicroControlId(value: unknown): value is CodexMicroControlId {
  return typeof value === 'string' && CONTROL_ID_SET.has(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidControlAction(control: CodexMicroControlId, action: unknown): action is 0 | 1 | 2 {
  if (typeof action !== 'number' || !Number.isInteger(action)) {
    return false
  }
  return ENCODER_ROTATION_CONTROLS.has(control) ? action === 2 : action === 0 || action === 1
}

export function parseCodexMicroInputEvent(value: unknown): CodexMicroInputEvent | null {
  if (!isPlainRecord(value)) {
    return null
  }

  if (value.kind === 'control') {
    const { control, action } = value
    if (!isCodexMicroControlId(control)) {
      return null
    }
    if (!isValidControlAction(control, action)) {
      return null
    }
    return { kind: 'control', control, action: action as 0 | 1 | 2 }
  }

  if (value.kind === 'radar') {
    const { angle, distance } = value
    if (typeof angle !== 'number' || !Number.isFinite(angle)) {
      return null
    }
    if (typeof distance !== 'number' || !Number.isFinite(distance)) {
      return null
    }
    return { kind: 'radar', angle, distance }
  }

  return null
}

const ERROR_STATE_KINDS = new Set(['conflict', 'permission-error', 'error'])
const ERROR_STATE_ALLOWED_KEYS = new Set(['kind', 'code', 'message'])

export function parseCodexMicroConnectionState(value: unknown): CodexMicroConnectionState | null {
  if (!isPlainRecord(value)) {
    return null
  }
  const { kind } = value

  if (kind === 'disabled' || kind === 'disconnected' || kind === 'connecting') {
    return { kind }
  }

  if (kind === 'connected') {
    if (value.firmware !== 'v0.4.1') {
      return null
    }
    const { battery, charging } = value
    if (
      battery !== undefined &&
      (typeof battery !== 'number' || !Number.isInteger(battery) || battery < 0 || battery > 100)
    ) {
      return null
    }
    if (charging !== undefined && typeof charging !== 'boolean') {
      return null
    }
    return {
      kind: 'connected',
      firmware: 'v0.4.1',
      ...(battery !== undefined ? { battery } : {}),
      ...(charging !== undefined ? { charging } : {})
    }
  }

  if (kind === 'read-only') {
    const { firmware, reason } = value
    if (firmware !== null && typeof firmware !== 'string') {
      return null
    }
    if (reason !== 'unknown-firmware') {
      return null
    }
    return { kind: 'read-only', firmware, reason: 'unknown-firmware' }
  }

  if (typeof kind === 'string' && ERROR_STATE_KINDS.has(kind)) {
    const keys = Object.keys(value)
    if (keys.some((key) => !ERROR_STATE_ALLOWED_KEYS.has(key))) {
      return null
    }
    const { code, message } = value
    if (typeof code !== 'string' || typeof message !== 'string') {
      return null
    }
    return { kind: kind as 'conflict' | 'permission-error' | 'error', code, message }
  }

  return null
}
