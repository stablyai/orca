import { e2eConfig } from '@/lib/e2e-config'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  type TerminalColdParkPolicyOverrides
} from './terminal-hidden-view-parking'
import { getParkedTerminalWatcherTabIds } from './terminal-parked-tab-watchers'

export type TerminalWorktreeParkingDebugVerdict = {
  worktreeId: string
  forceParked: boolean
  hasActivityTerminalPortal: boolean
  hasPendingSpawnWork: boolean
  hiddenSinceMs: number | null
  isVisible: boolean
  ordinaryParkingCovers: boolean
  parkCooldownUntilMs: number | null
  shouldMeasureHiddenWorktree: boolean
}

let worktreeVerdicts: TerminalWorktreeParkingDebugVerdict[] = []

// Why: ORCA_E2E_TERMINAL_PARKING_DELAY_MS must shrink BOTH the cold-park
// hysteresis and the hot-retain window — recently hidden tabs otherwise sit
// in the hot-retain working set for 5 minutes and never park within a test
// run. Gated on exposeStore so packaged builds ignore stray env vars.
export function getTerminalParkingPolicyOverrides(): TerminalColdParkPolicyOverrides {
  if (!e2eConfig.exposeStore) {
    return {}
  }
  const delayMs = e2eConfig.terminalParkingDelayMs
  const retentionLimit = e2eConfig.terminalRetentionLimit
  return {
    // Why the retention TTL keeps production timing: it is absolute (the
    // last-active exemption does not spare it), so shrinking it here would
    // evict the newest hidden worktree the cap specs assert stays mounted.
    ...(typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0
      ? { coldParkDelayMs: delayMs, hotRetainMs: delayMs }
      : {}),
    // Why: limit=1 lets a spec force-park with only two hidden un-parkable worktrees (production floor is 12).
    ...(typeof retentionLimit === 'number' && Number.isInteger(retentionLimit) && retentionLimit > 0
      ? { retentionLimit }
      : {})
  }
}

export function registerTerminalParkingDebugHandle(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  window.__terminalParkingDebug = {
    parkDelayMs:
      getTerminalParkingPolicyOverrides().coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS,
    parkedTabIds: () => getParkedTerminalWatcherTabIds(),
    retentionLimit: getTerminalParkingPolicyOverrides().retentionLimit ?? null,
    worktreeVerdicts: () => worktreeVerdicts
  }
}

export function recordTerminalWorktreeParkingDebugVerdicts(
  verdicts: TerminalWorktreeParkingDebugVerdict[]
): void {
  if (e2eConfig.exposeStore) {
    worktreeVerdicts = verdicts
  }
}

// Why: the parking e2e spec gates on window.__terminalParkingDebug existing
// shortly after launch. This module is statically imported by the park
// wiring, so registering at module load makes the handle visible before any
// tab parks.
registerTerminalParkingDebugHandle()
