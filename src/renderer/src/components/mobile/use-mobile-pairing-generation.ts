import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  canMintMobilePairingOffer,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'

type MutableRef<T> = { current: T }

/**
 * Mints (or rotates) a pairing QR. Every caller must go through this path so
 * signed-out Anywhere is refused rather than silently degraded to a local-only
 * code under the Relay label. Anywhere mint failures surface relayFailure and
 * clear any QR.
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
  setPairingQrError: (value: boolean) => void
  setPairLoading: (value: boolean) => void
  setRelayMintFailure: (value: MobileRelayMintFailure | null) => void
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
    setPairingQrError,
    setPairLoading,
    setRelayMintFailure
  } = params

  const generatePairing = useCallback(
    async (
      rotate: boolean,
      addressOverride?: string,
      connectionModeOverride?: MobilePairingConnectionMode
    ) => {
      const preferredMode = connectionModeOverride ?? connectionMode
      if (!canMintMobilePairingOffer({ connectionMode: preferredMode, signedIn })) {
        return
      }
      const requestId = ++pairingRequestIdRef.current
      hasGeneratedRef.current = true
      if (mountedRef.current) {
        setPairLoading(true)
      }
      try {
        const address = addressOverride ?? selectedAddress
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
            setPairingQrError(result.qrDataUrl === null)
            setRelayMintFailure(null)
          }
        } else {
          // Why: keep hasGenerated so step-2 auto-mint does not loop on failure.
          if (mountedRef.current) {
            setPairQrDataUrl(null)
            setPairingUrl(null)
            setPairingQrError(false)
            if (result.reason === 'relay_mint_failed' && result.relayFailure) {
              setRelayMintFailure(result.relayFailure)
            } else {
              setRelayMintFailure(null)
              // Why: IPC now forwards reason/guidance for all unavailability paths;
              // prefer that copy over a hard-coded WebSocket-only message.
              toast.error(
                result.guidance ??
                  translate(
                    'auto.components.mobile.MobilePage.b353e18de1',
                    'WebSocket transport is not running'
                  )
              )
            }
          }
        }
      } catch {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          hasGeneratedRef.current = false
          setPairQrDataUrl(null)
          setPairingUrl(null)
          setPairingQrError(false)
          setRelayMintFailure(null)
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
      setPairLoading,
      setPairQrDataUrl,
      setPairingUrl,
      setPairingQrError,
      setRelayMintFailure,
      signedIn
    ]
  )

  return { generatePairing }
}
