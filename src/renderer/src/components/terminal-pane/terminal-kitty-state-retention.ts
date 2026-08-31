import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'

const MAX_RETAINED_KITTY_STATES = 256
const retainedFlagsByPtyId = new Map<string, number>()

/** Retains proven protocol state while a live PTY has no mounted pane tracker. */
export function retainTerminalKittyState(
  ptyId: string | null | undefined,
  tracker: TerminalKittyKeyboardModeTracker
): void {
  const flags = tracker.snapshotFlags
  if (!ptyId || flags === undefined) {
    return
  }
  retainedFlagsByPtyId.delete(ptyId)
  retainedFlagsByPtyId.set(ptyId, flags)
  while (retainedFlagsByPtyId.size > MAX_RETAINED_KITTY_STATES) {
    const oldest = retainedFlagsByPtyId.keys().next().value
    if (oldest === undefined) {
      break
    }
    retainedFlagsByPtyId.delete(oldest)
  }
}

export function restoreRetainedTerminalKittyState(
  ptyId: string | null | undefined,
  tracker: TerminalKittyKeyboardModeTracker
): void {
  if (!ptyId || tracker.hasProvenBaseline) {
    return
  }
  const flags = retainedFlagsByPtyId.get(ptyId)
  if (flags === undefined) {
    return
  }
  tracker.resetForSnapshot()
  tracker.restoreSnapshotFlags(flags)
}

export function forgetRetainedTerminalKittyState(ptyId: string | null | undefined): void {
  if (ptyId) {
    retainedFlagsByPtyId.delete(ptyId)
  }
}

export function resetRetainedTerminalKittyStatesForTests(): void {
  retainedFlagsByPtyId.clear()
}
