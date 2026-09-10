// xterm's minimumContrastRatio range: 1 disables contrast correction entirely, 21 is the maximum
// WCAG ratio (black on white). Shared so main's persistence boundary and the renderer clamp alike.
export const MIN_TERMINAL_CONTRAST_RATIO = 1
export const MAX_TERMINAL_CONTRAST_RATIO = 21

/**
 * Clamps a user-supplied contrast floor (#10754). `undefined` means "unset", so callers fall back to
 * Orca's automatic background-luminance floor; anything unusable is treated the same way rather than
 * handed to xterm, which throws on a non-finite option.
 */
export function normalizeTerminalMinimumContrastRatio(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(MAX_TERMINAL_CONTRAST_RATIO, Math.max(MIN_TERMINAL_CONTRAST_RATIO, value))
}
