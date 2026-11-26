// When New bot wakes a sleeping WSL host on its own, and how long it reads "Waking…".
import type { WslHostConnectionState } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

/** This dialog's wake of one host. `token` names the attempt, so a stale answer can't touch a newer one;
 *  `awaitingMain`: the connect call gave up but main still connects. */
export type BotWslWake =
  | { phase: 'waking'; token: number; awaitingMain?: boolean }
  /** `leftIdle`: main has reported something other than idle since the failure. */
  | { phase: 'failed'; token: number; leftIdle?: boolean }

/** `toast`: tell the failure now. `refresh`: main finished the wake; re-read the host (and its projects). */
export type BotWslWakeStep = { wake: BotWslWake | undefined; toast: boolean; refresh?: boolean }

/** No wake yet, or a failure the host has since moved on from; one failed wake is never retried alone. */
export function botWslMayAutoWake(wake: BotWslWake | undefined): boolean {
  return wake === undefined
}

export function botWslShowsWaking(wake: BotWslWake | undefined): boolean {
  return wake?.phase === 'waking'
}

const MAIN_STILL_WAKING: readonly (WslHostConnectionState | undefined)[] = [
  'connecting',
  'reconnecting'
]

/** Attempt `token`'s connect call settled; an answer for an attempt no longer current changes nothing. */
export function botWslWakeSettled(
  current: BotWslWake | undefined,
  token: number,
  ok: boolean,
  mainState: WslHostConnectionState | undefined
): BotWslWakeStep {
  if (current?.phase !== 'waking' || current.token !== token) {
    return { wake: current, toast: false }
  }
  if (ok) {
    return { wake: undefined, toast: false }
  }
  // The renderer's connect has a short timeout; a slow boot is still main's to finish.
  return MAIN_STILL_WAKING.includes(mainState)
    ? { wake: { ...current, awaitingMain: true }, toast: false }
    : { wake: { phase: 'failed', token }, toast: true }
}

/** Attempt `token` ran past the cap without an answer: it failed. */
export function botWslWakeTimedOut(current: BotWslWake | undefined, token: number): BotWslWakeStep {
  return current?.phase === 'waking' && current.token === token
    ? { wake: { phase: 'failed', token }, toast: true }
    : { wake: current, toast: false }
}

/** Main's state for the host moved. */
export function botWslWakeAfterStatus(
  wake: BotWslWake | undefined,
  mainState: WslHostConnectionState | undefined
): BotWslWakeStep {
  if (wake?.phase === 'waking' && wake.awaitingMain) {
    if (mainState === 'ready') {
      return { wake: undefined, toast: false, refresh: true }
    }
    return MAIN_STILL_WAKING.includes(mainState)
      ? { wake, toast: false }
      : { wake: { phase: 'failed', token: wake.token }, toast: true }
  }
  if (wake?.phase === 'failed') {
    if (mainState !== 'idle') {
      return { wake: wake.leftIdle ? wake : { ...wake, leftIdle: true }, toast: false }
    }
    // Idle again after something else: a new sleep, so one more wake is allowed.
    return { wake: wake.leftIdle ? undefined : wake, toast: false }
  }
  return { wake, toast: false }
}
