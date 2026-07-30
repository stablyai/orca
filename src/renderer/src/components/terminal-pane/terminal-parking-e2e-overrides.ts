import { e2eConfig } from '@/lib/e2e-config'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  type TerminalColdParkPolicyOverrides
} from './terminal-hidden-view-parking'
import { getParkedTerminalWatcherTabIds } from './terminal-parked-tab-watchers'

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
    // Why the retention TTL keeps production timing: it is absolute, so
    // shrinking it here would evict the newest candidate despite fitting capacity.
    ...(typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0
      ? { coldParkDelayMs: delayMs, hotRetainMs: delayMs }
      : {}),
    // Why: a one-unit override lets two one-pane worktrees exceed the test budget.
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
    parkedTabIds: () => getParkedTerminalWatcherTabIds()
  }
}

// Why: the parking e2e spec gates on window.__terminalParkingDebug existing
// shortly after launch. This module is statically imported by the park
// wiring, so registering at module load makes the handle visible before any
// tab parks.
registerTerminalParkingDebugHandle()
