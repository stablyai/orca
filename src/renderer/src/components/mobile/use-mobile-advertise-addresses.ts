import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  orderedAdvertiseAddressesEqual,
  reconcileRelayPreferenceIndex,
  refreshOrderedAdvertiseAddresses,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'
import {
  deriveCustomAdvertiseAddresses,
  loadMobileAdvertiseAddressState,
  saveMobileAdvertiseAddressOrder
} from '../settings/mobile-advertise-address-order-store'
import { useMobilePairingGeneration } from './use-mobile-pairing-generation'
import { useMobilePairingRouteEditGeneration } from './use-mobile-pairing-route-edit-generation'
import type {
  UseMobileAdvertiseAddressesArgs,
  UseMobileAdvertiseAddressesResult
} from './mobile-advertise-address-contract'

const PAIRING_COPY_FAILED_KEY = 'auto.components.mobile.MobilePage.6a66e38943'

export function useMobileAdvertiseAddresses({
  mountedRef,
  interfacesActive,
  shouldAutoGenerate,
  connectionMode,
  advancedConnectionOrderEnabled
}: UseMobileAdvertiseAddressesArgs): UseMobileAdvertiseAddressesResult {
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>(
    () => loadMobileAdvertiseAddressState().addresses
  )
  const [relayPreferenceIndex, setRelayPreferenceIndex] = useState(
    () => loadMobileAdvertiseAddressState().relayPreferenceIndex
  )
  // Why: user-typed addresses survive empty discovery and interface churn (KTD5).
  const [customAddresses, setCustomAddresses] = useState<Set<string>>(
    () => loadMobileAdvertiseAddressState().customAddresses
  )
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const networkInterfacesRef = useRef<MobileNetworkInterface[]>([])
  const selectedAddressesRef = useRef(selectedAddresses)
  const customAddressesRef = useRef(customAddresses)
  const relayPreferenceIndexRef = useRef(relayPreferenceIndex)
  const generatePairingRef = useRef<UseMobileAdvertiseAddressesResult['generatePairing']>(
    async () => {}
  )
  const previousConnectionModeRef = useRef(connectionMode)
  const previousAdvancedConnectionOrderRef = useRef(advancedConnectionOrderEnabled)

  const persistAdvertiseOrder = useCallback(
    (addresses: string[], customs: ReadonlySet<string>, relayIndex: number) => {
      saveMobileAdvertiseAddressOrder(addresses, customs, relayIndex)
    },
    []
  )

  const {
    pairQrDataUrl,
    pairingUrl,
    pairLoading,
    hasGeneratedRef,
    generationInFlightRef,
    performPairingGeneration,
    invalidatePairingForRouteEdit,
    preparePairingPolicyChange,
    resetPairingGeneration
  } = useMobilePairingGeneration({
    mountedRef,
    selectedAddresses,
    relayPreferenceIndex,
    connectionMode,
    advancedConnectionOrderEnabled
  })
  const { scheduleRouteEditGeneration, cancelRouteEditGeneration } =
    useMobilePairingRouteEditGeneration(performPairingGeneration, invalidatePairingForRouteEdit)
  const generatePairing = useCallback(
    async (rotate: boolean, addressesOverride?: readonly string[], relayIndexOverride?: number) => {
      cancelRouteEditGeneration()
      await performPairingGeneration(rotate, addressesOverride, relayIndexOverride)
    },
    [cancelRouteEditGeneration, performPairingGeneration]
  )
  generatePairingRef.current = generatePairing
  selectedAddressesRef.current = selectedAddresses
  customAddressesRef.current = customAddresses
  relayPreferenceIndexRef.current = relayPreferenceIndex

  const loadNetworkInterfaces = useCallback(async () => {
    if (mountedRef.current) {
      setRefreshingNetworkInterfaces(true)
    }
    try {
      const result = await window.api.mobile.listNetworkInterfaces()
      const previousInterfaces = networkInterfacesRef.current
      const currentAddresses = selectedAddressesRef.current
      const currentCustoms = customAddressesRef.current
      const currentRelayIndex = relayPreferenceIndexRef.current
      const nextAddresses = refreshOrderedAdvertiseAddresses(
        currentAddresses,
        result.interfaces,
        previousInterfaces,
        { customAddresses: currentCustoms }
      )
      const nextCustoms = deriveCustomAdvertiseAddresses(
        nextAddresses,
        result.interfaces,
        currentCustoms
      )
      const addressesChanged = !orderedAdvertiseAddressesEqual(nextAddresses, currentAddresses)
      if (mountedRef.current) {
        networkInterfacesRef.current = result.interfaces
        setNetworkInterfaces(result.interfaces)
        if (addressesChanged) {
          const nextRelayIndex = reconcileRelayPreferenceIndex(
            currentAddresses,
            nextAddresses,
            currentRelayIndex
          )
          selectedAddressesRef.current = nextAddresses
          customAddressesRef.current = nextCustoms
          relayPreferenceIndexRef.current = nextRelayIndex
          setSelectedAddresses(nextAddresses)
          setCustomAddresses(nextCustoms)
          setRelayPreferenceIndex(nextRelayIndex)
          persistAdvertiseOrder(nextAddresses, nextCustoms, nextRelayIndex)
        }
      }
      // Remint when the ordered set changes, matching the single-address path.
      if (
        addressesChanged &&
        (hasGeneratedRef.current || generationInFlightRef.current) &&
        mountedRef.current
      ) {
        void generatePairingRef.current(
          true,
          nextAddresses,
          reconcileRelayPreferenceIndex(currentAddresses, nextAddresses, currentRelayIndex)
        )
      }
    } catch {
      // Network list is non-critical; the QR will still mint with default routing.
    } finally {
      if (mountedRef.current) {
        setRefreshingNetworkInterfaces(false)
      }
    }
  }, [generationInFlightRef, hasGeneratedRef, mountedRef, persistAdvertiseOrder])

  useEffect(() => {
    if (!interfacesActive) {
      return
    }
    void loadNetworkInterfaces()
  }, [interfacesActive, loadNetworkInterfaces])

  useEffect(() => {
    if (!shouldAutoGenerate && cancelRouteEditGeneration()) {
      // Why: leaving Step 2 must not rotate Relay state for an edit the user
      // can no longer see; returning will mint from the latest saved routes.
      resetPairingGeneration()
    }
  }, [cancelRouteEditGeneration, resetPairingGeneration, shouldAutoGenerate])

  const handleAddressesChange = useCallback(
    (addresses: string[]) => {
      const nextCustoms = deriveCustomAdvertiseAddresses(
        addresses,
        networkInterfacesRef.current,
        customAddresses
      )
      setSelectedAddresses(addresses)
      setCustomAddresses(nextCustoms)
      const nextRelayIndex = reconcileRelayPreferenceIndex(
        selectedAddressesRef.current,
        addresses,
        relayPreferenceIndex
      )
      selectedAddressesRef.current = addresses
      customAddressesRef.current = nextCustoms
      relayPreferenceIndexRef.current = nextRelayIndex
      setRelayPreferenceIndex(nextRelayIndex)
      persistAdvertiseOrder(addresses, nextCustoms, nextRelayIndex)
      scheduleRouteEditGeneration(addresses, nextRelayIndex)
    },
    [customAddresses, persistAdvertiseOrder, relayPreferenceIndex, scheduleRouteEditGeneration]
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
      selectedAddressesRef.current = addresses
      customAddressesRef.current = nextCustoms
      relayPreferenceIndexRef.current = nextIndex
      persistAdvertiseOrder(addresses, nextCustoms, nextIndex)
      scheduleRouteEditGeneration(addresses, nextIndex)
    },
    [customAddresses, persistAdvertiseOrder, scheduleRouteEditGeneration]
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
        toast.error(translate(PAIRING_COPY_FAILED_KEY, 'Failed to copy pairing code'))
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
    cancelRouteEditGeneration()
    preparePairingPolicyChange(shouldAutoGenerate)
    if (shouldAutoGenerate) {
      void generatePairing(true)
    }
  }, [
    advancedConnectionOrderEnabled,
    cancelRouteEditGeneration,
    connectionMode,
    generatePairing,
    preparePairingPolicyChange,
    shouldAutoGenerate
  ])

  // Why: mint on first Step 2 visit, then retain the token until Regenerate.
  useEffect(() => {
    if (!shouldAutoGenerate || hasGeneratedRef.current || generationInFlightRef.current) {
      return
    }
    void generatePairing(false)
  }, [generatePairing, generationInFlightRef, hasGeneratedRef, shouldAutoGenerate])

  const resetPairingOffer = useCallback(() => {
    cancelRouteEditGeneration()
    resetPairingGeneration()
  }, [cancelRouteEditGeneration, resetPairingGeneration])

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
