import { DIRECT_SSH_PANE_RETRY_SETTLEMENT_TIMEOUT_MS } from '@/components/terminal-pane/pty-connection/pty-connect-limits'
import type {
  TerminalPaneRecoveryOutcome,
  TerminalPaneRecoveryReason,
  TerminalTab,
  TerminalTabRecoveryLedger
} from '../../../../shared/terminal-tab-types'

// Why this module exists: recovery's budget used to live in module-level Maps
// keyed by tabId. Anything keyed outside the row needs a release path, and the
// release fired on every remount-driven pane disposal — so each remount erased
// the budget it had just consumed and the cap never held (crash b5cfc6ca).
// The ledger now lives on the row, so "the budget released itself" has no
// expression: reading the budget IS reading the tab.
//
// The control is not the count. A remount that mounts a pane which fails the
// same way is not evidence that anything changed, so recovery gates on an
// OBSERVED outcome, borrowing the direct-SSH pane retry vocabulary
// (DirectSshPaneRetryResult): an attempt that has not settled blocks the next
// one, and a settled failure refuses the same reason until a new trigger.

// Backstop only — a breadcrumb-emitting ceiling for a loop the outcome gate
// somehow failed to catch. The outcome gate is what stops a storm.
export const MAX_RECOVERIES_PER_WINDOW = 3
export const RECOVERY_WINDOW_MS = 5 * 60_000
// Why a cooldown exists: one incident can trip several detectors (stall watch,
// replay guard, input path) within seconds; the first remount fixes all of
// them, the rest must coalesce instead of re-remounting mid-reattach.
export const RECOVERY_COOLDOWN_MS = 15_000
// Why reuse the direct-SSH settlement timeout: the same 31s bound already
// decides when a pane's attach attempt has stopped being in flight. A 'pending'
// ledger older than that describes a pane that never reported, not one still
// working, so it must stop blocking rather than wedge recovery forever.
export const RECOVERY_SETTLEMENT_TIMEOUT_MS = DIRECT_SSH_PANE_RETRY_SETTLEMENT_TIMEOUT_MS

/** Why a request exists at all. Only 'automatic' is subject to the
 *  settled-failure refusal: a user pressing Retry, or an external lifecycle
 *  remount, IS the new trigger the refusal is waiting for. */
export type TerminalRecoveryTrigger = 'automatic' | 'user' | 'external'

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

/** True once the ledger describes an attempt nothing can still settle: the row
 *  moved to a generation this ledger never saw (authority change, SSH pane
 *  retry, activation respawn, external remount). Derived, so no writer can
 *  forget to mark it — and none can mark it wrongly either. */
function isSupersededLedger(tab: TerminalTab, ledger: TerminalTabRecoveryLedger): boolean {
  // Strictly forward: generation only ever increments, so a row that reads
  // LOWER is a host-snapshot rebuild that dropped the field, not a new trigger.
  // Treating that as one would hand the tab a fresh allowance per snapshot.
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

export function captureTabRecoveryGeneration(tab: TerminalTab | null | undefined): number {
  return tab?.recovery?.generation ?? 0
}

/**
 * The single admission decision. Runs read-only to fail a request fast, and
 * again inside the store write so a probe's await cannot open a window for two
 * panes to both consume the budget.
 */
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
    // Unconditional: the backstop must survive supersession, or anything that
    // bumps tab.generation each cycle would lift the ceiling along with it.
    return {
      admitted: false,
      declinedBy: 'window-cap',
      retryInMs: recent[0] + RECOVERY_WINDOW_MS - request.now
    }
  }
  if (request.trigger === 'user') {
    // The user asking again IS the new evidence. Only the window cap — the
    // backstop against a loop neither side can see — survives it.
    return ADMITTED
  }
  const outcome = readTerminalRecoveryOutcome(tab, request.now)
  if (outcome !== 'superseded') {
    if (ledger.outcome === 'pending') {
      if (outcome === 'pending') {
        // Re-requesting under an unsettled attempt is the storm: the remounted
        // pane fails the same way and asks again with a freshly captured epoch,
        // so an epoch check can never refuse it. Nothing has been observed yet.
        return {
          admitted: false,
          declinedBy: 'unsettled',
          retryInMs: ledger.startedAt + RECOVERY_SETTLEMENT_TIMEOUT_MS - request.now
        }
      }
      // Aged past the settlement bound with nobody reporting. Deliberately NOT
      // read as an observed failure: a pane kind with no settle path would
      // otherwise wedge its tab's recovery forever. The cooldown and the window
      // cap bound it instead.
    } else if (
      (ledger.outcome === 'failed' || ledger.outcome === 'timed-out') &&
      ledger.reason === request.reason
    ) {
      // A pane OBSERVED this reason fail after the last remount. Repeating it
      // re-requests exactly the action that just failed with no evidence
      // anything changed — wait for a real trigger (generation move, or user).
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

/** Record what the mounted pane observed. Returns null when this settlement is
 *  not the current attempt's, so the caller can leave the store untouched. */
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
