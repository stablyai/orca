import { useOrgRoster } from '../team/use-org-roster'

/**
 * Seats Team bills at Checkout: the active org's members (pending invites excluded), or 1 for a
 * personal account. Billing re-reads the count from auth; this is only for showing the total.
 */
export function useOrgSeatCount(orgId: string | null): number {
  const roster = useOrgRoster(orgId)
  if (!orgId || roster.result?.status !== 'ok') {
    return 1
  }
  return Math.max(1, roster.result.roster.members.length)
}
