import { isTerminalBackgroundLight } from './terminal-title-contrast'
import { normalizeTerminalMinimumContrastRatio } from './terminal-minimum-contrast-settings'

export {
  MAX_TERMINAL_CONTRAST_RATIO,
  MIN_TERMINAL_CONTRAST_RATIO,
  normalizeTerminalMinimumContrastRatio
} from './terminal-minimum-contrast-settings'

// Light backgrounds use 4.5 for invisible white ANSI text; dark uses 3 to rescue near-background glyphs without washing saturated colors (#7934/#9599/#10104). Accept mild lifts for below-floor Homebrew red/blue and Gruvbox Dark red; builtin tests pin exceptions.
export const LIGHT_BG_MIN_CONTRAST = 4.5
export const DARK_BG_MIN_CONTRAST = 3

// Follow composed luminance, not app mode: either slot may contain light/dark themes. Clamp explicit overrides too, including hand-edited nonfinite/out-of-range values.
export function resolveTerminalMinimumContrastRatio(
  background: string | undefined,
  appSurface: 'dark' | 'light',
  override?: unknown
): number {
  const configured = normalizeTerminalMinimumContrastRatio(override)
  if (configured !== undefined) {
    return configured
  }
  return isTerminalBackgroundLight(background, { appSurface })
    ? LIGHT_BG_MIN_CONTRAST
    : DARK_BG_MIN_CONTRAST
}
