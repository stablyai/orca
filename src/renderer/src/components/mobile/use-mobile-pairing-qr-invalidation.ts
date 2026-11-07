import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  canMintMobilePairingOffer,
  type MobilePairingConnectionMode
} from '../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'

type MutableRef<T> = { current: T }

/** Keep QR policy and dial hints aligned with mode/auth/relay changes, including other windows. */
export function useMobilePairingQrInvalidation(params: {
  connectionMode: MobilePairingConnectionMode
  irohRelayUrl: string | null
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
    irohRelayUrl,
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
  const handledIrohRelayRef = useRef(irohRelayUrl)

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

  // Routing-only changes refresh hints, never credentials; main also owns rotation on a mode mismatch.
  useLayoutEffect(() => {
    const modeChanged = connectionMode !== handledModeRef.current
    const relayChanged = irohRelayUrl !== handledIrohRelayRef.current
    handledModeRef.current = connectionMode
    handledIrohRelayRef.current = irohRelayUrl
    if (!modeChanged && !(relayChanged && connectionMode === 'iroh')) {
      return
    }
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
    irohRelayUrl,
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
