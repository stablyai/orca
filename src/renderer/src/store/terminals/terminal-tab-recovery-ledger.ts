import type {
  TerminalPaneRecoveryOutcome,
  TerminalPaneRecoveryReason,
  TerminalTab,
  TerminalTabRecoveryLedger
} from '../../../../shared/terminal-tab-types'

// Row-owned recovery survives remount disposal that erased module-map budgets (b5cfc6ca). Pending attempts block repeats; observed failure refuses the same reason until a new trigger.

// Breadcrumb-emitting backstop for loops the outcome gate misses.
export const MAX_RECOVERIES_PER_WINDOW = 3
export const RECOVERY_WINDOW_MS = 5 * 60_000
// Coalesce concurrent detectors so later ones cannot remount mid-reattach.
export const RECOVERY_COOLDOWN_MS = 15_000
// Expire unreported attempts so panes without settlement cannot wedge recovery forever.
export const RECOVERY_SETTLEMENT_TIMEOUT_MS = 31_000

/** Only automatic retries obey settled-failure refusal; user, external lifecycle or new host process is new evidence. Host evidence still counts against the window cap. */
export type TerminalRecoveryTrigger = 'automatic' | 'user' | 'external' | 'host-evidence'

export type TerminalRecoveryRemountRequest = {
  reason: TerminalPaneRecoveryReason
  trigger: TerminalRecoveryTrigger
  /** The recovery epoch the requesting pane captured, when it has one. */
  generation?: number
  now: number
}

export type TerminalRecoveryDecline =
  | { declinedBy: 'tab-missing' }
  | { declinedBy: 'stale-generation' }
  | { declinedBy: 'settled-failure' }
  | { declinedBy: 'window-cap'; retryInMs: number }
  | { declinedBy: 'unsettled'; retryInMs: number }
  | { declinedBy: 'cooldown'; retryInMs: number }

export type TerminalRecoveryAdmission =
  | { admitted: true }
  | ({ admitted: false } & TerminalRecoveryDecline)

export type TerminalRecoveryRemountResult =
  /** `generation` is the ledger epoch the remounted pane will capture. */
  { remounted: true; generation: number } | ({ remounted: false } & TerminalRecoveryDecline)

const ADMITTED: TerminalRecoveryAdmission = { admitted: true }

function recentAttempts(ledger: TerminalTabRecoveryLedger, now: number): number[] {
  return ledger.attemptedAt.filter((at) => now - at < RECOVERY_WINDOW_MS)
}

/** A newer row generation supersedes an unsettled ledger (authority change, SSH retry, activation or external remount); derive this so writers cannot omit it. */
function isSupersededLedger(tab: TerminalTab, ledger: TerminalTabRecoveryLedger): boolean {
  // Only forward generations are new evidence; lower values mean snapshots dropped the field, not a fresh allowance.
  return (tab.generation ?? 0) > ledger.tabGeneration
}

export function readTerminalRecoveryOutcome(
  tab: TerminalTab,
  now: number
): TerminalPaneRecoveryOutcome | null {
  const ledger = tab.recovery
  if (!ledger) {
    return null
  }
  if (isSupersededLedger(tab, ledger)) {
    return 'superseded'
  }
  if (ledger.outcome === 'pending' && now - ledger.startedAt >= RECOVERY_SETTLEMENT_TIMEOUT_MS) {
    return 'timed-out'
  }
  return ledger.outcome
}

/** Accept the connect path’s existing row to avoid another TerminalTab lookup. */
export function captureTabRecoveryGeneration(
  tab: Pick<TerminalTab, 'recovery'> | null | undefined
): number {
  return tab?.recovery?.generation ?? 0
}

/** Check before probing and again inside the write; an awaited probe must not let two panes spend the same budget. */
export function admitTerminalRecoveryRemount(
  tab: TerminalTab | null | undefined,
  request: TerminalRecoveryRemountRequest
): TerminalRecoveryAdmission {
  if (!tab) {
    return { admitted: false, declinedBy: 'tab-missing' }
  }
  const ledger = tab.recovery
  if (
    request.generation !== undefined &&
    request.generation !== captureTabRecoveryGeneration(tab)
  ) {
    return { admitted: false, declinedBy: 'stale-generation' }
  }
  if (request.trigger === 'external' || !ledger) {
    return ADMITTED
  }
  const recent = recentAttempts(ledger, request.now)
  if (recent.length >= MAX_RECOVERIES_PER_WINDOW) {
    // Keep the cap across supersession or generation bumps would lift the ceiling each cycle.
    return {
      admitted: false,
      declinedBy: 'window-cap',
      retryInMs: recent[0] + RECOVERY_WINDOW_MS - request.now
    }
  }
  if (request.trigger === 'user' || request.trigger === 'host-evidence') {
    // User retry is new evidence; only the window backstop survives it.
    return ADMITTED
  }
  const outcome = readTerminalRecoveryOutcome(tab, request.now)
  if (outcome !== 'superseded') {
    if (ledger.outcome === 'pending') {
      if (outcome === 'pending') {
        // Freshly captured epochs cannot stop repeated failure from an unsettled remount; wait for an observed outcome.
        return {
          admitted: false,
          declinedBy: 'unsettled',
          retryInMs: ledger.startedAt + RECOVERY_SETTLEMENT_TIMEOUT_MS - request.now
        }
      }
      // Unreported expiry is not observed failure; panes lacking settlement remain retryable under cooldown/window limits.
    } else if (
      (ledger.outcome === 'failed' || ledger.outcome === 'timed-out') &&
      ledger.reason === request.reason
    ) {
      // The same observed failure needs new evidence (generation change or user retry) before another remount.
      return { admitted: false, declinedBy: 'settled-failure' }
    }
  }
  const last = recent.at(-1)
  if (last !== undefined && request.now - last < RECOVERY_COOLDOWN_MS) {
    return {
      admitted: false,
      declinedBy: 'cooldown',
      retryInMs: last + RECOVERY_COOLDOWN_MS - request.now
    }
  }
  return ADMITTED
}

/** The ledger a remount writes, in the same object as the generation bump. */
export function nextTerminalRecoveryLedger(
  tab: TerminalTab,
  request: TerminalRecoveryRemountRequest,
  nextTabGeneration: number
): TerminalTabRecoveryLedger {
  const previous = tab.recovery
  // Carried across supersession on purpose — see the window-cap note above.
  const carriedAttempts = previous ? recentAttempts(previous, request.now) : []
  return {
    attemptedAt: [...carriedAttempts, request.now],
    generation: captureTabRecoveryGeneration(tab) + 1,
    outcome: 'pending',
    startedAt: request.now,
    reason: request.reason,
    tabGeneration: nextTabGeneration
  }
}

/** Return null for stale settlement so callers leave the store untouched. */
export function settledTerminalRecoveryLedger(
  tab: TerminalTab,
  generation: number,
  outcome: Exclude<TerminalPaneRecoveryOutcome, 'pending'>
): TerminalTabRecoveryLedger | null {
  const ledger = tab.recovery
  if (
    !ledger ||
    ledger.generation !== generation ||
    ledger.outcome !== 'pending' ||
    isSupersededLedger(tab, ledger)
  ) {
    return null
  }
  return { ...ledger, outcome }
}
