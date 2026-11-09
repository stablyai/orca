import { useEffect, useState } from 'react'

/**
 * Seats Team bills at Checkout: the active org's members (pending invites excluded), or 1 for a
 * personal account. Billing re-reads the count from auth; this is only for showing the total.
 */
export function useOrgSeatCount(orgId: string | null): number {
  const [members, setMembers] = useState<{ orgId: string; count: number } | null>(null)

  useEffect(() => {
    if (!orgId) {
      return
    }
    let disposed = false
    void window.api.orcaProfiles
      .orgMembersList({ orgId })
      .then((result) => {
        if (!disposed && result.status === 'ok') {
          setMembers({ orgId, count: result.roster.members.length })
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [orgId])

  if (!orgId) {
    return 1
  }
  return members?.orgId === orgId ? Math.max(1, members.count) : 1
}
