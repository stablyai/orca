// When New bot wakes a sleeping WSL host on its own, and how long it reads "Waking…".
import type { WslHostConnectionState } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

/** This dialog's wake of one host. `awaitingMain`: the connect call gave up but main still connects. */
export type BotWslWake =
  | { phase: 'waking'; awaitingMain?: boolean }
  /** `leftIdle`: main has reported something other than idle since the failure. */
  | { phase: 'failed'; leftIdle?: boolean }

/** No wake yet, or a failure the host has since moved on from; one failed wake is never retried alone. */
export function botWslMayAutoWake(wake: BotWslWake | undefined): boolean {
  return wake === undefined
}

export function botWslShowsWaking(wake: BotWslWake | undefined): boolean {
  return wake?.phase === 'waking'
}

/** The connect call settled; `toast` says the failure should be told now (main isn't still trying). */
export function botWslWakeSettled(
  ok: boolean,
  mainState: WslHostConnectionState | undefined
): { wake: BotWslWake | undefined; toast: boolean } {
  if (ok) {
    return { wake: undefined, toast: false }
  }
  // The renderer's connect has a short timeout; a slow boot is still main's to finish.
  return mainState === 'connecting'
    ? { wake: { phase: 'waking', awaitingMain: true }, toast: false }
    : { wake: { phase: 'failed' }, toast: true }
}

/** Main's state for the host moved; `toast` when a wake main was still finishing failed there. */
export function botWslWakeAfterStatus(
  wake: BotWslWake | undefined,
  mainState: WslHostConnectionState | undefined
): { wake: BotWslWake | undefined; toast: boolean } {
  if (wake?.phase === 'waking' && wake.awaitingMain) {
    if (mainState === 'ready') {
      return { wake: undefined, toast: false }
    }
    return mainState === 'connecting'
      ? { wake, toast: false }
      : { wake: { phase: 'failed' }, toast: true }
  }
  if (wake?.phase === 'failed') {
    if (mainState !== 'idle') {
      return { wake: wake.leftIdle ? wake : { phase: 'failed', leftIdle: true }, toast: false }
    }
    // Idle again after something else: a new sleep, so one more wake is allowed.
    return { wake: wake.leftIdle ? undefined : wake, toast: false }
  }
  return { wake, toast: false }
}
