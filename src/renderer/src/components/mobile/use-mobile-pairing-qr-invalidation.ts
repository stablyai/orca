import { useEffect, useRef } from 'react'
import {
  canMintMobilePairingOffer,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'

type MutableRef<T> = { current: T }

/**
 * Keeps the displayed pairing QR consistent with the selected path and sign-in
 * state. Signing out of Anywhere clears the Relay QR (Step 2 does not re-mint a
 * local-only code under the Relay label), signing in mints Relay, and a path
 * change (local or cross-window) invalidates the encoded policy — otherwise the
 * shown code silently mismatches what it actually encodes.
 */
export function useMobilePairingQrInvalidation(params: {
  connectionMode: MobilePairingConnectionMode
  signedIn: boolean
  pairLoading: boolean
  hasGeneratedRef: MutableRef<boolean>
  pairingRequestIdRef: MutableRef<number>
  setPairQrDataUrl: (value: string | null) => void
  setPairingUrl: (value: string | null) => void
  setPairLoading: (value: boolean) => void
  regenerate: (mode: MobilePairingConnectionMode, opts: { rotate: boolean }) => void
}): void {
  const {
    connectionMode,
    signedIn,
    pairLoading,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairingUrl,
    setPairLoading,
    regenerate
  } = params
  const wasSignedInRef = useRef(signedIn)
  // Tracks the mode we last acted on so the mode effect can tell a cross-window
  // preference sync apart from an already-handled change.
  const handledModeRef = useRef(connectionMode)

  // Sign-in/out edges on Anywhere: signing out clears the Relay QR without
  // re-minting (a local-only code must not appear under the Relay label);
  // signing in mints Relay. Anywhere stays selected across both edges. Clear
  // loading too so a superseded in-flight generate can't leave a stuck spinner.
  useEffect(() => {
    const wasSignedIn = wasSignedInRef.current
    wasSignedInRef.current = signedIn
    if (connectionMode !== 'automatic' || !hasGeneratedRef.current || wasSignedIn === signedIn) {
      return
    }
    pairingRequestIdRef.current += 1
    hasGeneratedRef.current = false
    setPairingUrl(null)
    setPairQrDataUrl(null)
    if (signedIn && canMintMobilePairingOffer({ connectionMode, signedIn })) {
      // Why: rotate on the sign-in edge — the token behind the QR cleared at
      // sign-out may have been exposed, so the fresh session mints fresh.
      regenerate(connectionMode, { rotate: true })
    } else {
      setPairLoading(false)
    }
  }, [
    connectionMode,
    signedIn,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairingUrl,
    setPairLoading,
    regenerate
  ])

  // Any path change — a user pick or another window persisting a new default —
  // invalidates the prior request before rotating so a late response cannot
  // restore a QR for the old policy. No updateSettings here (the caller/other
  // window already wrote it) so there is no cross-window loop.
  // Why: remint only when the new path may honestly encode a QR. Switching into
  // signed-out Anywhere must clear, not mint a local-only code under Relay.
  useEffect(() => {
    if (connectionMode === handledModeRef.current) {
      return
    }
    handledModeRef.current = connectionMode
    pairingRequestIdRef.current += 1
    const shouldRegenerate = hasGeneratedRef.current || pairLoading
    hasGeneratedRef.current = false
    setPairingUrl(null)
    setPairQrDataUrl(null)
    if (shouldRegenerate && canMintMobilePairingOffer({ connectionMode, signedIn })) {
      // Why: no rotate here — the main process rotates exactly once when the
      // requested mode differs from the pending token's minted mode, so the
      // initiating window and windows reacting to a cross-window preference
      // sync converge on the same fresh token instead of racing rotations.
      regenerate(connectionMode, { rotate: false })
    } else {
      // No honest re-mint (blocked path or nothing pending); drop spinner.
      setPairLoading(false)
    }
  }, [
    connectionMode,
    signedIn,
    pairLoading,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairingUrl,
    setPairLoading,
    regenerate
  ])
}
