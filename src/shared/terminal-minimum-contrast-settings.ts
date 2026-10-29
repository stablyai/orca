// Share xterm’s 1–21 range across persistence and renderer; 1 disables correction.
export const MIN_TERMINAL_CONTRAST_RATIO = 1
export const MAX_TERMINAL_CONTRAST_RATIO = 21

/** Unset/invalid values preserve the automatic luminance floor; never pass non-finite values to xterm. */
export function normalizeTerminalMinimumContrastRatio(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(MAX_TERMINAL_CONTRAST_RATIO, Math.max(MIN_TERMINAL_CONTRAST_RATIO, value))
}
