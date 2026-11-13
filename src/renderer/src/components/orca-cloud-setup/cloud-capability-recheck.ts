// "Try again" on the capability-off step (CAP-GATE), and the one automatic check when the step
// first shows. Main's Orca Cloud availability reads the capabilities stored with the session, which
// otherwise change only at the next session refresh (up to an access-token lifetime away). Auth
// grants Orca Cloud to a team that pays for a plan (PAID-TEAM-CHOOSE-PLAN), so asking auth again
// here lets a paying team move on at once instead of staying on "isn't turned on yet".

export type CloudCapabilityRecheckDeps = {
  /** Re-reads the profile's capabilities from auth and stores them with the session. */
  refreshAuth: () => Promise<unknown>
  /** Re-reads billing access (forced). */
  prefetchBilling: () => unknown
  /** Re-reads main's availability, which now sees the stored capabilities. */
  rereadAvailability: () => void
}

/** Never throws: a failed auth read still re-reads availability with what is stored. */
export async function recheckCloudCapability(deps: CloudCapabilityRecheckDeps): Promise<void> {
  void Promise.resolve()
    .then(deps.prefetchBilling)
    .catch(() => undefined)
  try {
    await deps.refreshAuth()
  } catch {
    // Availability is re-read below either way.
  } finally {
    deps.rereadAvailability()
  }
}
