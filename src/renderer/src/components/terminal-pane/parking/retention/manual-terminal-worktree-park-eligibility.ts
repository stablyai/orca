/** Manual parking reuses automatic safety gates but bypasses hysteresis, retain caps and time-based rechecks. */
import {
  canParkTerminalWorktreeRenderers,
  type ColdParkableTerminalTab
} from './terminal-hidden-view-parking'

// pendingActivationSpawn is sidebar-sort metadata retained by reattach; only an actual live PTY proves spawn settled.
function withoutSettledActivationSpawn(
  tabs: readonly ColdParkableTerminalTab[],
  hasLivePty: (tabId: string) => boolean
): ColdParkableTerminalTab[] {
  return tabs.map((tab) => {
    if (!tab.pendingActivationSpawn || !hasLivePty(tab.id)) {
      return tab
    }
    const { pendingActivationSpawn: _settled, ...rest } = tab
    return rest
  })
}

export function canManuallyParkTerminalWorktreeRenderers(args: {
  worktreeId: string
  terminalTabs: readonly ColdParkableTerminalTab[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  parkingEnabled: boolean
  hasLivePty: (tabId: string) => boolean
}): boolean {
  return (
    args.terminalTabs.length > 0 &&
    canParkTerminalWorktreeRenderers({
      ...args,
      terminalTabs: withoutSettledActivationSpawn(args.terminalTabs, args.hasLivePty),
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
