import { useState } from 'react'
import { usePairingOfferExpiry } from '../../../mobile/use-pairing-offer-expiry'

export type RuntimePairingLinkExpiry = { kind: 'expires'; at: number } | { kind: 'expired' } | null

/** A used link keeps working, so only an unused one reports its expiry. No auto-mint. */
export function useRuntimePairingLinkExpiry(args: {
  expiresAt: number | null
  used: boolean
  onExpired: () => void
}): RuntimePairingLinkExpiry {
  const { expiresAt, used, onExpired } = args
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
  if (typeof expiresAt !== 'number' || used) {
    return null
  }
  return expiredAt === expiresAt ? { kind: 'expired' } : { kind: 'expires', at: expiresAt }
}
