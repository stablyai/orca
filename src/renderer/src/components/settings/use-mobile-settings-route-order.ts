import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  orderedAdvertiseAddressesEqual,
  reconcileRelayPreferenceIndex,
  refreshOrderedAdvertiseAddresses,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'
import {
  deriveCustomAdvertiseAddresses,
  loadMobileAdvertiseAddressState,
  saveMobileAdvertiseAddressOrder
} from './mobile-advertise-address-order-store'
import {
  loadMobileAdvancedConnectionOrderEnabled,
  saveMobileAdvancedConnectionOrderEnabled
} from './mobile-advanced-connection-order-store'
import { useMobilePairingAddressPreference } from '../mobile/use-mobile-pairing-address-preference'

type UseMobileSettingsRouteOrderArgs = {
  mountedRef: MutableRefObject<boolean>
  invalidatePairing: () => void
}

type UseMobileSettingsRouteOrderResult = {
  networkInterfaces: MobileNetworkInterface[]
  selectedAddress: string | undefined
  selectedAddressIsCustom: boolean
  customAddresses: readonly string[]
  selectedAddresses: string[]
  relayPreferenceIndex: number
  advancedConnectionOrderEnabled: boolean
  refreshingNetworkInterfaces: boolean
  loadNetworkInterfaces: (opts?: { notifyOnError?: boolean }) => Promise<void>
  handleSelectedAddressChange: (address: string) => void
  handleCustomAddressSelect: (address: string) => void
  handleCustomAddressRemove: (address: string) => void
  handleAddressesChange: (addresses: string[]) => void
  handleRouteOrderChange: (addresses: string[], relayIndex: number) => void
  changeAdvancedConnectionOrderEnabled: (enabled: boolean) => void
}

export function useMobileSettingsRouteOrder({
  mountedRef,
  invalidatePairing
}: UseMobileSettingsRouteOrderArgs): UseMobileSettingsRouteOrderResult {
  const [initialOrder] = useState(loadMobileAdvertiseAddressState)
  const [networkInterfaces, setNetworkInterfaces] = useState<MobileNetworkInterface[]>([])
  const [selectedAddresses, setSelectedAddresses] = useState(initialOrder.addresses)
  const [relayPreferenceIndex, setRelayPreferenceIndex] = useState(
    initialOrder.relayPreferenceIndex
  )
  const [advancedConnectionOrderEnabled, setAdvancedConnectionOrderEnabled] = useState(
    loadMobileAdvancedConnectionOrderEnabled
  )
  const [refreshingNetworkInterfaces, setRefreshingNetworkInterfaces] = useState(false)
  const networkInterfacesRef = useRef<MobileNetworkInterface[]>([])
  const selectedAddressesRef = useRef(selectedAddresses)
  const customAddressesRef = useRef(initialOrder.customAddresses)
  const relayPreferenceIndexRef = useRef(relayPreferenceIndex)
  const invalidateStandardSelection = useCallback(() => invalidatePairing(), [invalidatePairing])
  const {
    selectedAddress,
    selectedAddressIsCustom,
    customAddresses,
    selectAddress: handleSelectedAddressChange,
    selectCustomAddress: handleCustomAddressSelect,
    removeCustomAddress: handleCustomAddressRemove,
    selectAddressAfterRefresh
  } = useMobilePairingAddressPreference({
    networkInterfaces,
    onSelectionInvalidated: invalidateStandardSelection
  })

  const loadNetworkInterfaces = useCallback(
    async (opts: { notifyOnError?: boolean } = {}) => {
      setRefreshingNetworkInterfaces(true)
      try {
        const result = await window.api.mobile.listNetworkInterfaces()
        if (!mountedRef.current) {
          return
        }
        const previousInterfaces = networkInterfacesRef.current
        networkInterfacesRef.current = result.interfaces
        setNetworkInterfaces(result.interfaces)
        selectAddressAfterRefresh(result.interfaces)
        const currentAddresses = selectedAddressesRef.current
        const nextAddresses = refreshOrderedAdvertiseAddresses(
          currentAddresses,
          result.interfaces,
          previousInterfaces,
          { customAddresses: customAddressesRef.current }
        )
        const orderedChanged = !orderedAdvertiseAddressesEqual(nextAddresses, currentAddresses)
        if (orderedChanged) {
          const nextRelayIndex = reconcileRelayPreferenceIndex(
            currentAddresses,
            nextAddresses,
            relayPreferenceIndexRef.current
          )
          const nextCustoms = deriveCustomAdvertiseAddresses(
            nextAddresses,
            result.interfaces,
            customAddressesRef.current
          )
          selectedAddressesRef.current = nextAddresses
          customAddressesRef.current = nextCustoms
          relayPreferenceIndexRef.current = nextRelayIndex
          setSelectedAddresses(nextAddresses)
          setRelayPreferenceIndex(nextRelayIndex)
          saveMobileAdvertiseAddressOrder(nextAddresses, nextCustoms, nextRelayIndex)
        }
        if (orderedChanged && advancedConnectionOrderEnabled) {
          invalidatePairing()
        }
      } catch {
        if (opts.notifyOnError && mountedRef.current) {
          toast.error(
            translate(
              'auto.components.settings.MobilePane.d714614dbf',
              'Failed to refresh network interfaces'
            )
          )
        }
      } finally {
        if (mountedRef.current) {
          setRefreshingNetworkInterfaces(false)
        }
      }
    },
    [advancedConnectionOrderEnabled, invalidatePairing, mountedRef, selectAddressAfterRefresh]
  )

  const handleAddressesChange = useCallback(
    (addresses: string[]): void => {
      const nextCustoms = deriveCustomAdvertiseAddresses(
        addresses,
        networkInterfacesRef.current,
        customAddressesRef.current
      )
      const nextRelayIndex = reconcileRelayPreferenceIndex(
        selectedAddressesRef.current,
        addresses,
        relayPreferenceIndexRef.current
      )
      selectedAddressesRef.current = addresses
      customAddressesRef.current = nextCustoms
      relayPreferenceIndexRef.current = nextRelayIndex
      setSelectedAddresses(addresses)
      setRelayPreferenceIndex(nextRelayIndex)
      saveMobileAdvertiseAddressOrder(addresses, nextCustoms, nextRelayIndex)
      invalidatePairing()
    },
    [invalidatePairing]
  )

  const handleRouteOrderChange = useCallback(
    (addresses: string[], relayIndex: number): void => {
      const nextRelayIndex = Math.max(0, Math.min(addresses.length, relayIndex))
      const nextCustoms = deriveCustomAdvertiseAddresses(
        addresses,
        networkInterfacesRef.current,
        customAddressesRef.current
      )
      selectedAddressesRef.current = addresses
      customAddressesRef.current = nextCustoms
      relayPreferenceIndexRef.current = nextRelayIndex
      setSelectedAddresses(addresses)
      setRelayPreferenceIndex(nextRelayIndex)
      saveMobileAdvertiseAddressOrder(addresses, nextCustoms, nextRelayIndex)
      invalidatePairing()
    },
    [invalidatePairing]
  )

  const changeAdvancedConnectionOrderEnabled = useCallback(
    (enabled: boolean): void => {
      if (enabled === advancedConnectionOrderEnabled) {
        return
      }
      if (enabled && selectedAddressesRef.current.length === 0 && selectedAddress) {
        const addresses = [selectedAddress]
        selectedAddressesRef.current = addresses
        relayPreferenceIndexRef.current = addresses.length
        setSelectedAddresses(addresses)
        setRelayPreferenceIndex(addresses.length)
        saveMobileAdvertiseAddressOrder(addresses, customAddressesRef.current, addresses.length)
      } else if (!enabled && selectedAddressesRef.current[0]) {
        handleSelectedAddressChange(selectedAddressesRef.current[0])
      }
      setAdvancedConnectionOrderEnabled(enabled)
      saveMobileAdvancedConnectionOrderEnabled(enabled)
      // Why: routeOrder changes reconnect semantics, so discard stale offers.
      invalidatePairing()
    },
    [
      advancedConnectionOrderEnabled,
      handleSelectedAddressChange,
      invalidatePairing,
      selectedAddress
    ]
  )

  return {
    networkInterfaces,
    selectedAddress,
    selectedAddressIsCustom,
    customAddresses,
    selectedAddresses,
    relayPreferenceIndex,
    advancedConnectionOrderEnabled,
    refreshingNetworkInterfaces,
    loadNetworkInterfaces,
    handleSelectedAddressChange,
    handleCustomAddressSelect,
    handleCustomAddressRemove,
    handleAddressesChange,
    handleRouteOrderChange,
    changeAdvancedConnectionOrderEnabled
  }
}
