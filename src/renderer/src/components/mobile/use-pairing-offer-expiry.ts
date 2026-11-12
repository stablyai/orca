import { useEffect, useEffectEvent } from 'react'

// Main reuses an offer only with more than a minute left, so a refresh here mints a fresh one.
export const PAIRING_OFFER_REFRESH_LEAD_MS = 60_000
// Timers stall while the computer sleeps; recheck the wall clock so a woken screen never keeps an expired code.
export const PAIRING_OFFER_WALL_CLOCK_RECHECK_MS = 15_000

/** Calls `onDue` at `expiresAt - leadMs` while this surface is mounted and visible. */
export function usePairingOfferExpiry(
  expiresAt: number | null,
  onDue: () => void,
  leadMs = PAIRING_OFFER_REFRESH_LEAD_MS
): void {
  const fire = useEffectEvent(onDue)

  useEffect(() => {
    // Hosts that send no expiry keep codes valid until scanned.
    if (typeof expiresAt !== 'number') {
      return
    }
    const dueAt = expiresAt - leadMs
    let timer: number | null = null
    const arm = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      // Hidden windows recheck on return instead of minting codes nobody can see.
      if (document.visibilityState === 'hidden') {
        return
      }
      timer = window.setTimeout(
        () => {
          timer = null
          // Not due yet (an interim recheck, or a timer firing a little early): keep waiting.
          if (Date.now() < dueAt) {
            arm()
            return
          }
          fire()
        },
        Math.min(Math.max(0, dueAt - Date.now()), PAIRING_OFFER_WALL_CLOCK_RECHECK_MS)
      )
    }
    arm()
    document.addEventListener('visibilitychange', arm)
    window.addEventListener('focus', arm)
    return () => {
      document.removeEventListener('visibilitychange', arm)
      window.removeEventListener('focus', arm)
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [expiresAt, leadMs])
}
