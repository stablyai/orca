// One "Move to this computer" (or "Apply changes again") at a time: a second click or a retry
// racing the first must not start another pack or apply. A timed-out run releases it.
let inFlightRun: number | null = null
let runCounter = 0

export function claimMoveRun(): number | null {
  if (inFlightRun !== null) {
    return null
  }
  inFlightRun = ++runCounter
  return inFlightRun
}

export function releaseMoveRun(run: number): void {
  if (inFlightRun === run) {
    inFlightRun = null
  }
}
