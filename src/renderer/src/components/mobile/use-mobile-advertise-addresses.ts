import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { MutableRefObject } from 'react'
import { translate } from '@/i18n/i18n'
import {
  orderedAdvertiseAddressesEqual,
  refreshOrderedAdvertiseAddresses,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'
import {
  deriveCustomAdvertiseAddresses,
  loadMobileAdvertiseAddressState,
  saveMobileAdvertiseAddressOrder
} from '../settings/mobile-advertise-address-order-store'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import { createMobilePairingQrRequest } from './mobile-pairing-qr-request'

export type UseMobileAdvertiseAddressesArgs = {
  mountedRef: MutableRefObject<boolean>
  /** When true, load/refresh interfaces (Mobile flow stage active). */
  interfacesActive: boolean
  /** When true and no QR yet, auto-mint a pairing offer. */
  shouldAutoGenerate: boolean
  connectionMode: MobilePairingConnectionMode
  advancedConnectionOrderEnabled: boolean
}

export type UseMobileAdvertiseAddressesResult = {
  networkInterfaces: MobileNetworkInterface[]
  selectedAddresses: string[]
  relayPreferenceIndex: number
  refreshingNetworkInterfaces: boolean
  pairQrDataUrl: string | null
  pairingUrl: string | null
  pairLoading: boolean
  loadNetworkInterfaces: () => Promise<void>
  handleAddressesChange: (addresses: string[]) => void
  handlePrimaryAddressChange: (address: string) => void
  handleRouteOrderChange: (addresses: string[], relayIndex: number) => void
  generatePairing: (
    rotate: boolean,
    addressesOverride?: readonly string[],
    relayIndexOverride?: number
  ) => Promise<void>
  copyPairingCode: () => Promise<void>
  /** Clear QR state and allow the auto-generate effect to mint again. */
  resetPairingOffer: () => void
}

export function useMobileAdvertiseAddresses({
  mountedRef,
  interfacesActive,
  shouldAutoGenerate,
  connectionMode,
  advancedConnectionOrderEnabled
}: UseMobileAdvertiseAddressesArgs): UseMobileAdvertiseAddressesResult {
  const [pairQrDataUrl, setPairQrDataUrl] = useState<string | null>(null)
  const [pairingUrl, setPairingUrl] = useState<string | null>(null)
  const [pairLoading, setPairLoading] = useState(false)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>(
    () => loadMobileAdvertiseAddressState().addresses
  )
  const [relayPreferenceIndex, setRelayPreferenceIndex] = useState(
    () => loadMobileAdvertiseAddressState().relayPreferenceIndex
  )
  // Why: remember which selections are user-typed customs so refresh can keep
  // them when discovery is empty / interfaces churn (KTD5).
  const [customAddresses, setCustomAddresses] = useState<Set<string>>(
    () => loadMobileAdvertiseAddressState().customAddresses
  )
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const hasGeneratedRef = useRef(false)
  const networkInterfacesRef = useRef<MobileNetworkInterface[]>([])
  const pairingRequestIdRef = useRef(0)
  const previousConnectionModeRef = useRef(connectionMode)
  const previousAdvancedConnectionOrderRef = useRef(advancedConnectionOrderEnabled)

  const persistAdvertiseOrder = useCallback(
    (addresses: string[], customs: ReadonlySet<string>, relayIndex: number) => {
      saveMobileAdvertiseAddressOrder(addresses, customs, relayIndex)
    },
    []
  )

  const generatePairing = useCallback(
    async (rotate: boolean, addressesOverride?: readonly string[], relayIndexOverride?: number) => {
      const requestId = ++pairingRequestIdRef.current
      if (mountedRef.current) {
        setPairLoading(true)
      }
      try {
        const addresses = [...(addressesOverride ?? selectedAddresses)]
        const relayIndex = relayIndexOverride ?? relayPreferenceIndex
        const result = await window.api.mobile.getPairingQR(
          createMobilePairingQrRequest({
            addresses,
            connectionMode,
            orderedRoutes: advancedConnectionOrderEnabled,
            relayPreferenceIndex: relayIndex,
            rotate
          })
        )
        if (result.available) {
          if (mountedRef.current && requestId === pairingRequestIdRef.current) {
            setPairQrDataUrl(result.qrDataUrl)
            setPairingUrl(result.pairingUrl)
          }
          hasGeneratedRef.current = true
        } else if (mountedRef.current && requestId === pairingRequestIdRef.current) {
          toast.error(
            translate(
              'auto.components.mobile.MobilePage.b353e18de1',
              'WebSocket transport is not running'
            )
          )
        }
      } catch {
        if (mountedRef.current && requestId === pairingRequestIdRef.current) {
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
      advancedConnectionOrderEnabled,
      connectionMode,
      mountedRef,
      relayPreferenceIndex,
      selectedAddresses
    ]
  )

  const loadNetworkInterfaces = useCallback(async () => {
    if (mountedRef.current) {
      setRefreshingNetworkInterfaces(true)
    }
    try {
      const result = await window.api.mobile.listNetworkInterfaces()
      const previousInterfaces = networkInterfacesRef.current
      const nextAddresses = refreshOrderedAdvertiseAddresses(
        selectedAddresses,
        result.interfaces,
        previousInterfaces,
        { customAddresses }
      )
      const nextCustoms = deriveCustomAdvertiseAddresses(
        nextAddresses,
        result.interfaces,
        customAddresses
      )
      const addressesChanged = !orderedAdvertiseAddressesEqual(nextAddresses, selectedAddresses)
      if (mountedRef.current) {
        networkInterfacesRef.current = result.interfaces
        setNetworkInterfaces(result.interfaces)
        if (addressesChanged) {
          setSelectedAddresses(nextAddresses)
          setCustomAddresses(nextCustoms)
          const nextRelayIndex = Math.min(relayPreferenceIndex, nextAddresses.length)
          setRelayPreferenceIndex(nextRelayIndex)
          persistAdvertiseOrder(nextAddresses, nextCustoms, nextRelayIndex)
        }
      }
      // Remint when the ordered set changes — same rotate semantics as today's
      // single-address change path.
      if (addressesChanged && hasGeneratedRef.current && mountedRef.current) {
        void generatePairing(
          true,
          nextAddresses,
          Math.min(relayPreferenceIndex, nextAddresses.length)
        )
      }
    } catch {
      // Network list is non-critical; the QR will still mint with default routing.
    } finally {
      if (mountedRef.current) {
        setRefreshingNetworkInterfaces(false)
      }
    }
  }, [
    selectedAddresses,
    customAddresses,
    generatePairing,
    mountedRef,
    persistAdvertiseOrder,
    relayPreferenceIndex
  ])

  useEffect(() => {
    if (!interfacesActive) {
      return
    }
    void loadNetworkInterfaces()
  }, [interfacesActive, loadNetworkInterfaces])

  const handleAddressesChange = useCallback(
    (addresses: string[]) => {
      const nextCustoms = deriveCustomAdvertiseAddresses(
        addresses,
        networkInterfacesRef.current,
        customAddresses
      )
      setSelectedAddresses(addresses)
      setCustomAddresses(nextCustoms)
      const nextRelayIndex = Math.min(relayPreferenceIndex, addresses.length)
      setRelayPreferenceIndex(nextRelayIndex)
      persistAdvertiseOrder(addresses, nextCustoms, nextRelayIndex)
      // Switching advertise order must remint so the QR encodes the new list.
      void generatePairing(true, addresses, nextRelayIndex)
    },
    [customAddresses, generatePairing, persistAdvertiseOrder, relayPreferenceIndex]
  )

  const handleRouteOrderChange = useCallback(
    (addresses: string[], relayIndex: number) => {
      const nextIndex = Math.max(0, Math.min(addresses.length, relayIndex))
      const nextCustoms = deriveCustomAdvertiseAddresses(
        addresses,
        networkInterfacesRef.current,
        customAddresses
      )
      setSelectedAddresses(addresses)
      setCustomAddresses(nextCustoms)
      setRelayPreferenceIndex(nextIndex)
      persistAdvertiseOrder(addresses, nextCustoms, nextIndex)
      void generatePairing(true, addresses, nextIndex)
    },
    [customAddresses, generatePairing, persistAdvertiseOrder]
  )

  const handlePrimaryAddressChange = useCallback(
    (address: string) => {
      const addresses = [address, ...selectedAddresses.filter((candidate) => candidate !== address)]
      handleAddressesChange(addresses)
    },
    [handleAddressesChange, selectedAddresses]
  )

  const copyPairingCode = useCallback(async () => {
    if (!pairingUrl) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(pairingUrl)
      if (mountedRef.current) {
        toast.success(
          translate('auto.components.mobile.MobilePage.3c1f7168bb', 'Pairing code copied')
        )
      }
    } catch (err) {
      console.error('writeClipboardText failed', err)
      if (mountedRef.current) {
        toast.error(
          translate('auto.components.mobile.MobilePage.6a66e38943', 'Failed to copy pairing code')
        )
      }
    }
  }, [mountedRef, pairingUrl])

  useEffect(() => {
    const policyChanged =
      previousConnectionModeRef.current !== connectionMode ||
      previousAdvancedConnectionOrderRef.current !== advancedConnectionOrderEnabled
    if (!policyChanged) {
      return
    }
    previousConnectionModeRef.current = connectionMode
    previousAdvancedConnectionOrderRef.current = advancedConnectionOrderEnabled
    pairingRequestIdRef.current++
    setPairQrDataUrl(null)
    setPairingUrl(null)
    setPairLoading(false)
    hasGeneratedRef.current = shouldAutoGenerate
    if (shouldAutoGenerate) {
      void generatePairing(true)
    }
  }, [advancedConnectionOrderEnabled, connectionMode, generatePairing, shouldAutoGenerate])

  // Why: when Step 2 first becomes visible, mint a pairing offer so the
  // user sees a real QR immediately. Subsequent visits keep the existing
  // token unless they hit Regenerate.
  useEffect(() => {
    if (!shouldAutoGenerate || hasGeneratedRef.current) {
      return
    }
    void generatePairing(false)
  }, [shouldAutoGenerate, generatePairing])

  const resetPairingOffer = useCallback(() => {
    pairingRequestIdRef.current++
    hasGeneratedRef.current = false
    setPairQrDataUrl(null)
    setPairingUrl(null)
    setPairLoading(false)
  }, [])

  return {
    networkInterfaces,
    selectedAddresses,
    relayPreferenceIndex,
    refreshingNetworkInterfaces,
    pairQrDataUrl,
    pairingUrl,
    pairLoading,
    loadNetworkInterfaces,
    handleAddressesChange,
    handlePrimaryAddressChange,
    handleRouteOrderChange,
    generatePairing,
    copyPairingCode,
    resetPairingOffer
  }
}
