import { useEffect, useRef } from 'react'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'

type MutableRef<T> = { current: T }

/** Invalidate the shown code on pairing-policy changes, including other windows', without writing settings back. Returns the handled-mode ref this window's own mode changes must set first. */
export function useMobilePairingPolicySync(params: {
  connectionMode: MobilePairingConnectionMode
  relayLocalPath: boolean
  signedIn: boolean
  qrDisplayedRef: MutableRef<boolean>
  loadingRef: MutableRef<boolean>
  invalidatePairing: (opts?: { armRotate?: boolean }) => void
  generateQR: (opts: { rotate?: boolean }) => Promise<void>
}): MutableRef<MobilePairingConnectionMode> {
  const { connectionMode, relayLocalPath, signedIn, qrDisplayedRef, loadingRef } = params
  const { invalidatePairing, generateQR } = params
  const handledModeRef = useRef(connectionMode)
  const handledLocalPathRef = useRef(relayLocalPath)
  const wasSignedInRef = useRef(signedIn)

  // Invalidate displayed/pending Relay codes after sign-out while retaining Anywhere selection.
  useEffect(() => {
    const wasSignedIn = wasSignedInRef.current
    wasSignedInRef.current = signedIn
    if (wasSignedIn && !signedIn && connectionMode === 'automatic') {
      invalidatePairing()
    }
  }, [signedIn, connectionMode, invalidatePairing])

  useEffect(() => {
    if (connectionMode === handledModeRef.current) {
      return
    }
    handledModeRef.current = connectionMode
    invalidatePairing({ armRotate: false })
  }, [connectionMode, invalidatePairing])

  // Remint a shown code now: main rotates a pending code whose reach changed, so the stale one stops pairing.
  useEffect(() => {
    if (relayLocalPath === handledLocalPathRef.current) {
      return
    }
    handledLocalPathRef.current = relayLocalPath
    const hadCode = qrDisplayedRef.current || loadingRef.current
    invalidatePairing({ armRotate: false })
    if (hadCode) {
      void generateQR({ rotate: false })
    }
  }, [relayLocalPath, qrDisplayedRef, loadingRef, invalidatePairing, generateQR])

  return handledModeRef
}
