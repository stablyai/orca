/**
 * Cosmetic TUI scroll glide: visual-only sub-row translateY while mouse
 * reporting owns the wheel (Claude, Codex, OpenCode fullscreen, etc.).
 * Does not change buffer ydisp — reports stay discrete; this only eases the paint.
 */

export type TerminalTuiScrollGlideIntensity = 'off' | 'subtle' | 'medium'

/** Max |offset| as a fraction of one cell height. */
export function resolveTerminalTuiScrollGlideMaxCellFraction(
  intensity: TerminalTuiScrollGlideIntensity | undefined
): number {
  switch (intensity) {
    case 'medium':
      return 0.65
    case 'off':
      return 0
    case 'subtle':
    default:
      return 0.35
  }
}

export function normalizeTerminalTuiScrollGlideIntensity(
  value: unknown
): TerminalTuiScrollGlideIntensity {
  if (value === 'off' || value === 'medium' || value === 'subtle') {
    return value
  }
  return 'subtle'
}

type ViewportWithTuiGlide = {
  nudgeTuiGlide?: (deltaPx: number, maxCellFraction?: number) => void
}

type TerminalWithViewport = {
  _core?: {
    _viewport?: ViewportWithTuiGlide
  }
}

/**
 * Why: mouse-reporting TUIs never hit host scrollTop remainder; we still want
 * a short visual lag so trackpad flicks do not feel like pure row snaps.
 * No-op when the xterm patch lacks nudgeTuiGlide or intensity is off.
 */
export function nudgeTerminalTuiScrollGlide(
  terminal: unknown,
  deltaY: number,
  intensity: TerminalTuiScrollGlideIntensity | undefined
): void {
  const maxFraction = resolveTerminalTuiScrollGlideMaxCellFraction(intensity)
  if (maxFraction <= 0 || !Number.isFinite(deltaY) || deltaY === 0) {
    return
  }
  const viewport = (terminal as TerminalWithViewport)._core?._viewport
  viewport?.nudgeTuiGlide?.(deltaY, maxFraction)
}
