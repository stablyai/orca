export const DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT = 5_000
export const DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN = 1_000
export const DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX = 50_000
export const DESKTOP_TERMINAL_SCROLLBACK_ROW_PRESETS = [5_000, 10_000, 25_000, 50_000] as const

export const LEGACY_TERMINAL_SCROLLBACK_BYTES_1_MB = 1_000_000

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

// Scale beyond the floor so large scrollbacks retain more backlog. 120 chars/row estimates text plus escapes; this is a memory bound, not exact retention.
export const TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS = 2 * 1024 * 1024
const OUTPUT_BACKLOG_CHARS_PER_SCROLLBACK_ROW = 120

export function terminalOutputBacklogCapChars(scrollbackRows: unknown): number {
  const rows = normalizeDesktopTerminalScrollbackRows(scrollbackRows)
  return Math.max(
    TERMINAL_OUTPUT_BACKLOG_MIN_CAP_CHARS,
    rows * OUTPUT_BACKLOG_CHARS_PER_SCROLLBACK_ROW
  )
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
