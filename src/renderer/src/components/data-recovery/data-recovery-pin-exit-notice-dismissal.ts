// Why: after a successful agent-catalog v1 pin, show a one-shot exit path once
// so RC dogfooders know how to return to stable without reinstalling over live
// v1 data. Key by pin creation time so a later remigration (downgrade then
// re-open v1) re-surfaces the notice for the new pin.

const STORAGE_KEY = 'orca.dataRecovery.pinExitNotice.dismissedCreatedAtMs'

/** Pin timestamps are best-effort (`listRecoveryPoints` leaves them null when the
 *  stat fails), so a null must still produce a stable key — writing nothing made
 *  Got-it a session-only no-op and re-showed the notice on every launch. A later
 *  pin that does carry a timestamp keys differently and resurfaces as intended. */
const UNKNOWN_CREATED_AT_KEY = 'unknown'

function dismissalKey(createdAtMs: number | null): string {
  return createdAtMs === null ? UNKNOWN_CREATED_AT_KEY : String(createdAtMs)
}

export function isPinExitNoticeDismissed(createdAtMs: number | null): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return false
    }
    return raw === dismissalKey(createdAtMs)
  } catch {
    return false
  }
}

export function dismissPinExitNotice(createdAtMs: number | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, dismissalKey(createdAtMs))
  } catch {
    // localStorage may be unavailable; the notice remains dismissible for the session via state.
  }
}
