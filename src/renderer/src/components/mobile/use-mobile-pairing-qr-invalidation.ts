import { useEffect, useRef } from 'react'
import {
  canMintMobilePairingOffer,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'

type MutableRef<T> = { current: T }

/** Keep QR policy aligned with mode/auth changes, including other windows; Relay sign-out clears instead of falling back to local-only. */
export function useMobilePairingQrInvalidation(params: {
  connectionMode: MobilePairingConnectionMode
  signedIn: boolean
  pairLoading: boolean
  hasGeneratedRef: MutableRef<boolean>
  pairingRequestIdRef: MutableRef<number>
  setPairQrDataUrl: (value: string | null) => void
  setPairQrSize: (value: number | null) => void
  setPairingUrl: (value: string | null) => void
  setPairingQrError: (value: boolean) => void
  setPairLoading: (value: boolean) => void
  setRelayMintFailure?: (value: null) => void
  regenerate: (mode: MobilePairingConnectionMode, opts: { rotate: boolean }) => void
}): void {
  const {
    connectionMode,
    signedIn,
    pairLoading,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairQrSize,
    setPairingUrl,
    setPairingQrError,
    setPairLoading,
    setRelayMintFailure,
    regenerate
  } = params
  const wasSignedInRef = useRef(signedIn)
  // Distinguish new cross-window mode preferences from changes already handled here.
  const handledModeRef = useRef(connectionMode)

  // On Relay auth changes, clear old QR/loading; sign-in may remint, but sign-out cannot silently mint a local-only code.
  useEffect(() => {
    const wasSignedIn = wasSignedInRef.current
    wasSignedInRef.current = signedIn
    if (connectionMode !== 'automatic' || !hasGeneratedRef.current || wasSignedIn === signedIn) {
      return
    }
    pairingRequestIdRef.current += 1
    hasGeneratedRef.current = false
    setPairingUrl(null)
    setPairingQrError(false)
    setPairQrDataUrl(null)
    setPairQrSize(null)
    setRelayMintFailure?.(null)
    if (signedIn && canMintMobilePairingOffer({ connectionMode, signedIn })) {
      // Rotate after sign-in because the token cleared at sign-out may already have been exposed.
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
    setPairQrSize,
    setPairingUrl,
    setPairingQrError,
    setPairLoading,
    setRelayMintFailure,
    regenerate
  ])

  // Invalidate late old-policy responses before reminting; the preference is already saved, so do not write it back across windows.
  useEffect(() => {
    if (connectionMode === handledModeRef.current) {
      return
    }
    handledModeRef.current = connectionMode
    pairingRequestIdRef.current += 1
    const shouldRegenerate = hasGeneratedRef.current || pairLoading
    hasGeneratedRef.current = false
    setPairingUrl(null)
    setPairingQrError(false)
    setPairQrDataUrl(null)
    setPairQrSize(null)
    setRelayMintFailure?.(null)
    if (shouldRegenerate && canMintMobilePairingOffer({ connectionMode, signedIn })) {
      // Main rotates once on mode mismatch so windows reacting to the same preference share one new token.
      regenerate(connectionMode, { rotate: false })
    } else {
      setPairLoading(false)
    }
  }, [
    connectionMode,
    signedIn,
    pairLoading,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairQrSize,
    setPairingUrl,
    setPairingQrError,
    setPairLoading,
    setRelayMintFailure,
    regenerate
  ])
}
