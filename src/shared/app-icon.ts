export const APP_ICON_OPTIONS = [
  { id: 'classic', label: 'Classic Orca' },
  { id: 'watercolor', label: 'Watercolor Orca' },
  { id: 'blue', label: 'Blue Orca' }
] as const

export type BuiltInAppIconId = (typeof APP_ICON_OPTIONS)[number]['id']

// Why one id, not a stored path: the imported image always lives at a fixed userData location.
export const CUSTOM_APP_ICON_ID = 'custom'

export type AppIconId = BuiltInAppIconId | typeof CUSTOM_APP_ICON_ID

export const DEFAULT_APP_ICON_ID: BuiltInAppIconId = 'classic'

function isAppIconId(value: unknown): value is AppIconId {
  return value === CUSTOM_APP_ICON_ID || APP_ICON_OPTIONS.some((option) => option.id === value)
}

export function normalizeAppIconId(value: unknown): AppIconId {
  return isAppIconId(value) ? value : DEFAULT_APP_ICON_ID
}

export const CUSTOM_APP_ICON_MAX_BYTES = 10 * 1024 * 1024
export const CUSTOM_APP_ICON_MIN_SIDE = 64
// Why 2048: decoding runs on the main process, and the stored copy is downscaled to 1024 anyway.
export const CUSTOM_APP_ICON_MAX_SIDE = 2048

export type CustomAppIconImportFailureCode =
  | 'unsupportedFormat'
  | 'unreadable'
  | 'tooLarge'
  | 'notSquare'
  | 'tooSmall'
  | 'tooBig'
  | 'undecodable'
  | 'saveFailed'

export type CustomAppIconImportResult =
  | { ok: true; previewDataUrl: string }
  | { ok: false; code: CustomAppIconImportFailureCode }
