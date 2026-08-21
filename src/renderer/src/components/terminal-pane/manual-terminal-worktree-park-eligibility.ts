/**
 * Eligibility for the on-demand ("Park terminal") path.
 *
 * Why split from terminal-hidden-view-parking: that module owns the automatic
 * cold-park policy — the hysteresis clock, hot-retain cap, and recheck
 * deadlines. Manual parking reuses its safety gates but deliberately bypasses
 * every time-based one, so the divergence lives here instead of accruing
 * `nowMs: 0` special cases inside the policy module.
 */
import {
  canParkTerminalWorktreeRenderers,
  type ColdParkableTerminalTab
} from './terminal-hidden-view-parking'

// Why: pendingActivationSpawn is sidebar-sort suppression, not a spawn-in-flight
// signal. First activation stamps it on every tab and only a fresh
// updateTabPtyId consumes it, so a tab whose PTY was reattached (not respawned)
// keeps it forever. The automatic path can wait it out; a manual park must not
// be refused by that residue, so drop it wherever the tab already has a live
// PTY — the only trustworthy "spawn settled" signal (tab.ptyId is a wake hint).
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
      // Why: the user asked for this park explicitly, so skip the hidden-duration
      // hysteresis the automatic path uses — but keep every safety gate below it.
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs: 0,
      nowMs: 0,
      coldParkDelayMs: 0
    })
  )
}
