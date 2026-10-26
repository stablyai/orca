import { e2eConfig } from '@/lib/e2e-config'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  type TerminalColdParkPolicyOverrides
} from './terminal-hidden-view-parking'
import { getParkedTerminalWatcherTabIds } from './terminal-parked-tab-watchers'
import { resolveTabScrollbackBuffers } from './leaf-scrollback-resolution'
import { useAppStore } from '@/store'

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

// Shrink hysteresis and hot-retain together for timely E2E parks; exposeStore keeps packaged builds immune to stray env flags.
export function getTerminalParkingPolicyOverrides(): TerminalColdParkPolicyOverrides {
  if (!e2eConfig.exposeStore) {
    return {}
  }
  const delayMs = e2eConfig.terminalParkingDelayMs
  const retentionLimit = e2eConfig.terminalRetentionLimit
  return {
    // Keep absolute retention TTL unchanged so count-cap tests retain their newest hidden worktree.
    ...(typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0
      ? { coldParkDelayMs: delayMs, hotRetainMs: delayMs }
      : {}),
    // A test limit of one permits force-park with just two hidden unrestorable worktrees.
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
    // Use the shared resolver because captures may live in either scrollback store.
    resolveLeafScrollback: (tabId) => resolveTabScrollbackBuffers(useAppStore.getState(), tabId),
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

// Register debug at static import so E2E startup can see it before any tab parks.
registerTerminalParkingDebugHandle()
