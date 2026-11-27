/** Manual parking reuses automatic safety gates but bypasses hysteresis, retain caps and time-based rechecks. */
import {
  canParkTerminalWorktreeRenderers,
  type ActivationSpawnSettled,
  type ColdParkableTerminalTab
} from './terminal-hidden-view-parking'

export function canManuallyParkTerminalWorktreeRenderers(args: {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  parkingEnabled: boolean
  isActivationSpawnSettled: ActivationSpawnSettled
}): boolean {
  return (
    args.terminalTabs.length > 0 &&
    canParkTerminalWorktreeRenderers({
      ...args,
      // Explicit parking bypasses hysteresis while retaining the safety gates.
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs: 0,
      nowMs: 0,
      coldParkDelayMs: 0
    })
  )
}
