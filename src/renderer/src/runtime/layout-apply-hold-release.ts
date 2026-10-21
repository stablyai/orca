// The holds one layout.apply takes, released together and once: on its answer, or 15 s after the
// send when the call or main's frame never comes (the holds would otherwise outlast main's frames).

const HOLD_TIMEOUT_MS = 15_000

export function releaseLayoutApplyHolds(
  commandType: string,
  holds: readonly ((() => void) | null)[]
): () => void {
  const held = holds.filter((hold) => hold !== null)
  let released = false
  // Why a task later: a handler that resolves a promise (drag-out) acts in its awaiting caller,
  // microtasks after the handler returns.
  const release = (): void => {
    clearTimeout(expiry)
    if (released) {
      return
    }
    released = true
    for (const hold of held) {
      setTimeout(hold, 0)
    }
  }
  const expiry =
    held.length > 0
      ? setTimeout(() => {
          console.warn(`[layout-owner] ${commandType} hold released: no answer in 15s`)
          release()
        }, HOLD_TIMEOUT_MS)
      : undefined
  return release
}
