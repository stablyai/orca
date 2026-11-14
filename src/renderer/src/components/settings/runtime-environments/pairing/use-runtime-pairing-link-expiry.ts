import { useState } from 'react'
import type { RuntimeAccessGrant } from '../../../../../../shared/runtime-access-grants'
import { usePairingOfferExpiry } from '../../../mobile/use-pairing-offer-expiry'

export type RuntimePairingLinkExpiry = { kind: 'expires'; at: number } | { kind: 'expired' } | null

/** A used link keeps working, so only an unused one reports its expiry. No auto-mint. */
export function useRuntimePairingLinkExpiry(args: {
  expiresAt: number | null
  grantId: string | null
  grants: readonly RuntimeAccessGrant[]
  onExpired: () => void
}): RuntimePairingLinkExpiry {
  const { expiresAt, grantId, grants, onExpired } = args
  const [expiredAt, setExpiredAt] = useState<number | null>(() =>
    expiresAt !== null && Date.now() >= expiresAt ? expiresAt : null
  )
  usePairingOfferExpiry(
    expiresAt,
    () => {
      setExpiredAt(expiresAt)
      // Reread grants: a link used just before expiry stays valid.
      onExpired()
    },
    0
  )
  const used = grants.some((grant) => grant.deviceId === grantId && grant.lastSeenAt !== null)
  if (typeof expiresAt !== 'number' || used) {
    return null
  }
  return expiredAt === expiresAt ? { kind: 'expired' } : { kind: 'expires', at: expiresAt }
}
