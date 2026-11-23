// Why: the scheduler falls back to host time for a zone it cannot read, so a typo would silently move a run.
export function isAutomationTimeZoneSupported(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
