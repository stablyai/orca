import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  canMintMobilePairingOffer,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'

type MutableRef<T> = { current: T }

/**
 * Mints (or rotates) a pairing QR. Every caller must go through this path so
 * signed-out Anywhere is refused rather than silently degraded to a local-only
 * code under the Relay label.
 */
export function useMobilePairingGeneration(params: {
  connectionMode: MobilePairingConnectionMode
  signedIn: boolean
  selectedAddress: string | undefined
  mountedRef: MutableRef<boolean>
  hasGeneratedRef: MutableRef<boolean>
  pairingRequestIdRef: MutableRef<number>
  setPairQrDataUrl: (value: string | null) => void
  setPairingUrl: (value: string | null) => void
  setPairLoading: (value: boolean) => void
  /** Mode the minted QR actually encodes (degraded Relay mints report
   *  'local-only'); null while no QR is shown. */
  setEncodedConnectionMode: (value: MobilePairingConnectionMode | null) => void
}): {
  generatePairing: (
    rotate: boolean,
    addressOverride?: string,
    connectionModeOverride?: MobilePairingConnectionMode
  ) => Promise<void>
} {
  const {
    connectionMode,
    signedIn,
    selectedAddress,
    mountedRef,
    hasGeneratedRef,
    pairingRequestIdRef,
    setPairQrDataUrl,
    setPairingUrl,
    setPairLoading,
    setEncodedConnectionMode
  } = params

  const generatePairing = useCallback(
    async (
      rotate: boolean,
      addressOverride?: string,
      connectionModeOverride?: MobilePairingConnectionMode
    ) => {
      const preferredMode = connectionModeOverride ?? connectionMode
      // Why: every mint path (auto-generate, regenerate, address change, path
      // invalidation) must refuse signed-out Anywhere rather than degrade to a
      // local-only QR under the Relay label.
      if (!canMintMobilePairingOffer({ connectionMode: preferredMode, signedIn })) {
        return
      }
      const requestId = ++pairingRequestIdRef.current
      // Mark the request synchronously so state changes cannot make the
      // Step 2 auto-generate effect start a second offer in parallel.
      hasGeneratedRef.current = true
      if (mountedRef.current) {
        setPairLoading(true)
      }
      try {
        const address = addressOverride ?? selectedAddress
        // canMint already requires sign-in for Anywhere, so preferred is honest.
        const result = await window.api.mobile.getPairingQR({
          ...(address ? { address } : {}),
          connectionMode: preferredMode,
          ...(rotate ? { rotate: true } : {})
        })
        if (requestId !== pairingRequestIdRef.current) {
          return
        }
        if (result.available) {
          if (mountedRef.current) {
            setPairQrDataUrl(result.qrDataUrl)
            setPairingUrl(result.pairingUrl)
            setEncodedConnectionMode(result.connectionMode)
          }
        } else {
          hasGeneratedRef.current = false
          if (mountedRef.current) {
            setPairQrDataUrl(null)
            setPairingUrl(null)
            setEncodedConnectionMode(null)
            toast.error(
              translate(
                'auto.components.mobile.MobilePage.b353e18de1',
                'WebSocket transport is not running'
              )
            )
          }
        }
      } catch {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          hasGeneratedRef.current = false
          setPairQrDataUrl(null)
          setPairingUrl(null)
          setEncodedConnectionMode(null)
          toast.error(
            translate(
              'auto.components.mobile.MobilePage.4c8bd11c1a',
              'Failed to generate pairing code'
            )
          )
        }
      } finally {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          setPairLoading(false)
        }
      }
    },
    [
      connectionMode,
      hasGeneratedRef,
      mountedRef,
      pairingRequestIdRef,
      selectedAddress,
      setEncodedConnectionMode,
      setPairLoading,
      setPairQrDataUrl,
      setPairingUrl,
      signedIn
    ]
  )

  return { generatePairing }
}
