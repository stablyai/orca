export const DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT = 5_000
export const DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN = 1_000
export const DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX = 50_000
export const DESKTOP_TERMINAL_SCROLLBACK_ROW_PRESETS = [5_000, 10_000, 25_000, 50_000] as const

export const LEGACY_TERMINAL_SCROLLBACK_BYTES_1_MB = 1_000_000
export const LEGACY_TERMINAL_SCROLLBACK_BYTES_10_MB = 10_000_000
export const LEGACY_TERMINAL_SCROLLBACK_BYTES_25_MB = 25_000_000
export const LEGACY_TERMINAL_SCROLLBACK_BYTES_50_MB = 50_000_000
export const LEGACY_TERMINAL_SCROLLBACK_BYTES_100_MB = 100_000_000

export const LEGACY_TERMINAL_SCROLLBACK_BUCKET_5K_MAX_BYTES = 17_500_000
export const LEGACY_TERMINAL_SCROLLBACK_BUCKET_10K_MAX_BYTES = 37_500_000
export const LEGACY_TERMINAL_SCROLLBACK_BUCKET_25K_MAX_BYTES = 75_000_000

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clampRows(value: number, min: number): number {
  return Math.min(DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX, Math.max(min, Math.floor(value)))
}

export function normalizeDesktopTerminalScrollbackRows(value: unknown): number {
  if (!isFiniteNumber(value)) {
    return DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
  }
  return clampRows(value, DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN)
}

export function normalizeDesktopTerminalSnapshotRows(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) {
    return undefined
  }
  return clampRows(value, 0)
}

export function legacyTerminalScrollbackBytesToRows(bytes: unknown): number {
  if (!isFiniteNumber(bytes) || bytes <= 0) {
    return DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
  }
  if (bytes <= LEGACY_TERMINAL_SCROLLBACK_BYTES_1_MB) {
    return DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN
  }
  if (bytes < LEGACY_TERMINAL_SCROLLBACK_BUCKET_5K_MAX_BYTES) {
    return DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
  }
  if (bytes < LEGACY_TERMINAL_SCROLLBACK_BUCKET_10K_MAX_BYTES) {
    return 10_000
  }
  if (bytes < LEGACY_TERMINAL_SCROLLBACK_BUCKET_25K_MAX_BYTES) {
    return 25_000
  }
  return DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX
}
