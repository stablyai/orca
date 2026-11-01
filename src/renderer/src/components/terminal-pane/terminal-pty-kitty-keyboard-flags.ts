import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'

type RegisteredPtyKittyKeyboardModeTracker = {
  tracker: TerminalKittyKeyboardModeTracker
  token: symbol
}

const ptyKittyKeyboardModeTrackers = new Map<string, RegisteredPtyKittyKeyboardModeTracker>()
const retainedPtyKittyKeyboardFlags = new Map<string, number>()

export function registerPtyKittyKeyboardModeTracker(
  ptyId: string,
  tracker: TerminalKittyKeyboardModeTracker
): symbol {
  const token = Symbol(ptyId)
  ptyKittyKeyboardModeTrackers.set(ptyId, { tracker, token })
  return token
}

export function unregisterPtyKittyKeyboardModeTracker(ptyId: string, token: symbol): void {
  const registration = ptyKittyKeyboardModeTrackers.get(ptyId)
  if (!registration || registration.token !== token) {
    return
  }

  const snapshotFlags = registration.tracker.hasProvenBaseline
    ? registration.tracker.snapshotFlags
    : undefined
  if (snapshotFlags === undefined) {
    retainedPtyKittyKeyboardFlags.delete(ptyId)
  } else {
    // Keep proven mode for a parked pane without treating unknown mode as zero.
    retainedPtyKittyKeyboardFlags.set(ptyId, snapshotFlags)
  }
  ptyKittyKeyboardModeTrackers.delete(ptyId)
}

/** Reattach replay is ordered after the prior binding, so it can correct a previously proven mode. */
export function primeReattachedPtyKittyKeyboardModeTracker(ptyId: string, token: symbol): void {
  const registration = ptyKittyKeyboardModeTrackers.get(ptyId)
  if (!registration || registration.token !== token || registration.tracker.hasProvenBaseline) {
    return
  }
  const retainedFlags = retainedPtyKittyKeyboardFlags.get(ptyId)
  if (retainedFlags !== undefined) {
    registration.tracker.restoreSnapshotFlags(retainedFlags)
  }
}

export function getPtyKittyKeyboardFlags(ptyId: string): number {
  const active = ptyKittyKeyboardModeTrackers.get(ptyId)
  return active
    ? (active.tracker.snapshotFlags ?? 0)
    : (retainedPtyKittyKeyboardFlags.get(ptyId) ?? 0)
}

export function resetPtyKittyKeyboardModeTrackersForTests(): void {
  ptyKittyKeyboardModeTrackers.clear()
  retainedPtyKittyKeyboardFlags.clear()
}
