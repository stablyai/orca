import { useEffect, useRef } from 'react'
import { canMintMobilePairingOffer } from '../../../../shared/mobile-pairing-connection-mode'
import type { MobilePairingPath } from '../../../../shared/mobile-pairing-path'

type MutableRef<T> = { current: T }

/** Invalidates visible and in-flight offers when their connection choice or authorization changes. */
export function useMobilePairingQrInvalidation(params: {
  connectionMode: MobilePairingPath
  relayAuthorized: boolean
  configurationId?: string
  pairLoading: boolean
  hasGeneratedRef: MutableRef<boolean>
  pairingRequestIdRef: MutableRef<number>
  setPairQrDataUrl: (value: string | null) => void
  setPairQrSize: (value: number | null) => void
  setPairingUrl: (value: string | null) => void
  setPairingQrError: (value: boolean) => void
  setPairLoading: (value: boolean) => void
  setRelayMintFailure?: (value: null) => void
  regenerate: (mode: MobilePairingPath, opts: { rotate: boolean }) => void
}): void {
  const {
    connectionMode,
    relayAuthorized,
    configurationId,
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
  const previous = useRef({ connectionMode, relayAuthorized, configurationId })
  useEffect(() => {
    const old = previous.current
    previous.current = { connectionMode, relayAuthorized, configurationId }
    const pathChanged = old.connectionMode !== connectionMode
    const authorizationChanged = old.relayAuthorized !== relayAuthorized
    const configurationChanged = old.configurationId !== configurationId
    if (
      !pathChanged &&
      (connectionMode === 'local-only' || (!authorizationChanged && !configurationChanged))
    )
      return
    const shouldRegenerate = hasGeneratedRef.current || pairLoading
    pairingRequestIdRef.current += 1
    hasGeneratedRef.current = false
    setPairingUrl(null)
    setPairingQrError(false)
    setPairQrDataUrl(null)
    setPairQrSize(null)
    setRelayMintFailure?.(null)
    if (shouldRegenerate && canMintMobilePairingOffer({ connectionMode, relayAuthorized })) {
      // Main rotates on a path change; re-authorization/config replacement must also retire the old code.
      regenerate(connectionMode, { rotate: !pathChanged })
    } else {
      setPairLoading(false)
    }
  }, [
    connectionMode,
    relayAuthorized,
    configurationId,
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
