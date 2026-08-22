import type { TerminalModes } from './terminal-modes'
import { TerminalModeStateTracker } from './terminal-mode-state-tracker'

const MOUSE_TRACKING_MODES = ['none', 'x10', 'vt200', 'drag', 'any'] as const

/**
 * Resolves the terminal modes a reattached pane should re-arm after painting a
 * raw relay replay tail: the attach-boundary seed advanced by every mode
 * sequence inside the replay itself. Returns null when there is no seed — the
 * caller keeps its legacy byte-inference in that case.
 */
export function resolveReplayRestoredModes(args: {
  seedModes: TerminalModes | undefined | null
  replayData: string | undefined
}): TerminalModes | null {
  if (!args.seedModes) {
    return null
  }
  const tracker = new TerminalModeStateTracker()
  tracker.seed(args.seedModes)
  if (args.replayData) {
    tracker.scan(args.replayData)
  }
  return tracker.getModes()
}

/** Validates an untrusted attach-payload modes value; malformed shapes yield undefined, never a throw. */
export function parseTerminalModes(value: unknown): TerminalModes | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const input = value as Record<string, unknown>
  if (
    typeof input.bracketedPaste !== 'boolean' ||
    typeof input.mouseTracking !== 'boolean' ||
    typeof input.applicationCursor !== 'boolean' ||
    typeof input.alternateScreen !== 'boolean'
  ) {
    return undefined
  }
  if (
    input.mouseTrackingMode !== undefined &&
    !MOUSE_TRACKING_MODES.includes(input.mouseTrackingMode as never)
  ) {
    return undefined
  }
  if (
    (input.sgrMouseMode !== undefined && typeof input.sgrMouseMode !== 'boolean') ||
    (input.sgrMousePixelsMode !== undefined && typeof input.sgrMousePixelsMode !== 'boolean')
  ) {
    return undefined
  }
  if (
    input.kittyKeyboardFlags !== undefined &&
    (typeof input.kittyKeyboardFlags !== 'number' ||
      !Number.isInteger(input.kittyKeyboardFlags) ||
      input.kittyKeyboardFlags < 0)
  ) {
    return undefined
  }
  return {
    bracketedPaste: input.bracketedPaste,
    mouseTracking: input.mouseTracking,
    ...(input.mouseTrackingMode !== undefined
      ? { mouseTrackingMode: input.mouseTrackingMode as TerminalModes['mouseTrackingMode'] }
      : {}),
    ...(input.sgrMouseMode !== undefined ? { sgrMouseMode: input.sgrMouseMode } : {}),
    ...(input.sgrMousePixelsMode !== undefined
      ? { sgrMousePixelsMode: input.sgrMousePixelsMode }
      : {}),
    applicationCursor: input.applicationCursor,
    alternateScreen: input.alternateScreen,
    ...(input.kittyKeyboardFlags !== undefined
      ? { kittyKeyboardFlags: input.kittyKeyboardFlags }
      : {})
  }
}
