import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'

const ptyKittyKeyboardModeTrackers = new Map<string, TerminalKittyKeyboardModeTracker>()

export function registerPtyKittyKeyboardModeTracker(
  ptyId: string,
  tracker: TerminalKittyKeyboardModeTracker
): void {
  ptyKittyKeyboardModeTrackers.set(ptyId, tracker)
}

export function unregisterPtyKittyKeyboardModeTracker(
  ptyId: string,
  tracker?: TerminalKittyKeyboardModeTracker
): void {
  if (tracker && ptyKittyKeyboardModeTrackers.get(ptyId) !== tracker) {
    return
  }
  ptyKittyKeyboardModeTrackers.delete(ptyId)
}

export function getPtyKittyKeyboardFlags(ptyId: string): number {
  return ptyKittyKeyboardModeTrackers.get(ptyId)?.flags ?? 0
}

export function resetPtyKittyKeyboardModeTrackersForTests(): void {
  ptyKittyKeyboardModeTrackers.clear()
}
