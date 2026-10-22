import { DESKTOP_AWAY_SECONDS } from '../../../shared/desktop-away-threshold'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

// The one record of user presence, from trusted renderer input only: the on-screen scan's gate
// and the marking guard both read it. Main's "not away" only answers the scan that asked — it
// means idle under the threshold, so stamping it as now could stretch presence to twice that.
let presenceGated = true
let presentAt = Number.NEGATIVE_INFINITY

/** False where there is no native idle query (browsers): the window gate stands alone. */
export function setPresenceGated(gated: boolean): void {
  presenceGated = gated
  presentAt = Number.NEGATIVE_INFINITY
}

/** Trusted renderer input. */
export function notePresence(): void {
  presentAt = Date.now()
}

/** Trusted input within the desktop away threshold, or no idle query to ask (browsers). */
export function isPresenceConfirmed(): boolean {
  return !presenceGated || Date.now() - presentAt < DESKTOP_AWAY_SECONDS * 1000
}

/** How long presence holds without new input; null where it is not gated (browsers). */
export function presenceRemainingMs(): number | null {
  return presenceGated
    ? Math.max(0, Math.round(DESKTOP_AWAY_SECONDS * 1000 - (Date.now() - presentAt)))
    : null
}

export function createAutoAckPresenceCheck(
  readAway: () => Promise<boolean | undefined>,
  onPresent: () => void
): { request: () => void; dispose: () => void } {
  let disposed = false
  let pending = false
  return {
    request() {
      if (disposed || pending) {
        return
      }
      pending = true
      void readAway()
        .then((away) => {
          // Unknown presence must not clear unread attention.
          if (!disposed && away === false) {
            onPresent()
          }
        })
        .catch(() => {})
        .finally(() => {
          pending = false
        })
    },
    dispose() {
      disposed = true
    }
  }
}

export function subscribeAutoAckPresenceSignals(
  onRescan: () => void,
  onInput: () => void
): () => void {
  const input = (event: Event): void => {
    if (event.isTrusted) {
      onInput()
    }
  }
  document.addEventListener('visibilitychange', onRescan)
  window.addEventListener('focus', onRescan)
  window.addEventListener('pointerdown', input)
  window.addEventListener('pointermove', input)
  window.addEventListener('wheel', input, { passive: true })
  // Why capture: xterm stops the keydowns it handles before they bubble to the window.
  addAppKeyListener('keydown', input)
  return () => {
    document.removeEventListener('visibilitychange', onRescan)
    window.removeEventListener('focus', onRescan)
    window.removeEventListener('pointerdown', input)
    window.removeEventListener('pointermove', input)
    window.removeEventListener('wheel', input)
    removeAppKeyListener('keydown', input)
  }
}
