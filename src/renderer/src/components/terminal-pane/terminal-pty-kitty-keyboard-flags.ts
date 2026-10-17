import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'

const ptyKittyKeyboardModeTrackers = new Map<string, TerminalKittyKeyboardModeTracker>()
const retainedPtyKittyKeyboardFlags = new Map<string, number>()

export function registerPtyKittyKeyboardModeTracker(
  ptyId: string,
  tracker: TerminalKittyKeyboardModeTracker
): void {
  retainedPtyKittyKeyboardFlags.delete(ptyId)
  ptyKittyKeyboardModeTrackers.set(ptyId, tracker)
}

export function unregisterPtyKittyKeyboardModeTracker(
  ptyId: string,
  tracker?: TerminalKittyKeyboardModeTracker
): void {
  if (tracker && ptyKittyKeyboardModeTrackers.get(ptyId) !== tracker) {
    return
  }

  const snapshotFlags = ptyKittyKeyboardModeTrackers.get(ptyId)?.snapshotFlags
  if (snapshotFlags === undefined) {
    retainedPtyKittyKeyboardFlags.delete(ptyId)
  } else {
    // Keep proven mode for a parked pane without treating unknown mode as zero.
    retainedPtyKittyKeyboardFlags.set(ptyId, snapshotFlags)
  }
  ptyKittyKeyboardModeTrackers.delete(ptyId)
}

export function getPtyKittyKeyboardFlags(ptyId: string): number {
  return (
    ptyKittyKeyboardModeTrackers.get(ptyId)?.snapshotFlags ??
    retainedPtyKittyKeyboardFlags.get(ptyId) ??
    0
  )
}

export function resetPtyKittyKeyboardModeTrackersForTests(): void {
  ptyKittyKeyboardModeTrackers.clear()
  retainedPtyKittyKeyboardFlags.clear()
}
