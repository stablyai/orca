import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'
import {
  useMobilePairingCustomAddress,
  useMobilePairingCustomAddresses
} from './use-mobile-pairing-custom-address'
import {
  addMobilePairingCustomAddress,
  removeMobilePairingCustomAddress
} from '../../../../shared/mobile-pairing-custom-address'

function haveSameAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index])
}

export type MobilePairingAddressChange = {
  address: string | undefined
  source: 'external' | 'refresh' | 'user'
}

export function useMobilePairingAddressPreference(args: {
  networkInterfaces: readonly MobileNetworkInterface[]
  onSelectionInvalidated: (change: MobilePairingAddressChange) => void
}): {
  selectedAddress: string | undefined
  selectedAddressIsCustom: boolean
  customAddresses: readonly string[]
  selectAddress: (address: string) => void
  selectCustomAddress: (address: string) => void
  removeCustomAddress: (address: string) => void
  selectAddressAfterRefresh: (interfaces: readonly MobileNetworkInterface[]) => void
} {
  const { networkInterfaces, onSelectionInvalidated } = args
  const updateSettings = useAppStore((state) => state.updateSettings)
  const savedCustomAddress = useMobilePairingCustomAddress()
  const savedCustomAddresses = useMobilePairingCustomAddresses()
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(savedCustomAddress)
  const [selectedAddressIsCustom, setSelectedAddressIsCustom] = useState(
    savedCustomAddress !== undefined
  )
  const [customAddresses, setCustomAddresses] = useState(savedCustomAddresses)
  const selectedAddressRef = useRef(selectedAddress)
  const selectedAddressIsManualRef = useRef(savedCustomAddress !== undefined)
  const selectedAddressWasExplicitlySelectedRef = useRef(savedCustomAddress !== undefined)
  const customAddressesRef = useRef(savedCustomAddresses)
  const observedCustomAddressRef = useRef(savedCustomAddress)
  const pendingCustomAddressWritesRef = useRef<(string | undefined)[]>([])

  const selectAddressAfterRefresh = useCallback(
    (interfaces: readonly MobileNetworkInterface[]): void => {
      const nextAddress = selectRefreshedNetworkAddress(
        selectedAddressRef.current,
        interfaces,
        selectedAddressIsManualRef.current,
        selectedAddressWasExplicitlySelectedRef.current
      )
      if (nextAddress === selectedAddressRef.current) {
        return
      }
      // Why: the first resolution picks the same default main already minted
      // with, so invalidating there would drop a QR that is still correct.
      const hadSelection = selectedAddressRef.current !== undefined
      selectedAddressRef.current = nextAddress
      selectedAddressIsManualRef.current = false
      selectedAddressWasExplicitlySelectedRef.current = false
      setSelectedAddress(nextAddress)
      setSelectedAddressIsCustom(false)
      if (hadSelection) {
        onSelectionInvalidated({ address: nextAddress, source: 'refresh' })
      }
    },
    [onSelectionInvalidated]
  )

  const commitAddress = useCallback(
    (address: string, isManual: boolean): void => {
      const addressChanged = selectedAddressRef.current !== address
      if (
        !addressChanged &&
        selectedAddressIsManualRef.current === isManual &&
        selectedAddressWasExplicitlySelectedRef.current
      ) {
        return
      }
      selectedAddressRef.current = address
      selectedAddressIsManualRef.current = isManual
      selectedAddressWasExplicitlySelectedRef.current = true
      setSelectedAddress(address)
      setSelectedAddressIsCustom(isManual)
      const customAddress = isManual ? address : undefined
      const pendingWrites = pendingCustomAddressWritesRef.current
      const effectiveCustomAddress =
        pendingWrites.length > 0 ? pendingWrites.at(-1) : observedCustomAddressRef.current
      if (customAddress !== effectiveCustomAddress) {
        pendingWrites.push(customAddress)
        if (customAddress) {
          const nextCustomAddresses = addMobilePairingCustomAddress(
            customAddressesRef.current,
            customAddress
          )
          customAddressesRef.current = nextCustomAddresses
          setCustomAddresses(nextCustomAddresses)
          void updateSettings({
            mobilePairingCustomAddress: customAddress,
            mobilePairingCustomAddresses: nextCustomAddresses
          })
        } else {
          void updateSettings({ mobilePairingCustomAddress: null })
        }
      }
      if (addressChanged) {
        onSelectionInvalidated({ address, source: 'user' })
      }
    },
    [onSelectionInvalidated, updateSettings]
  )

  const selectAddress = useCallback(
    (address: string): void => {
      commitAddress(address, !networkInterfaces.some((iface) => iface.address === address))
    },
    [commitAddress, networkInterfaces]
  )

  const selectCustomAddress = useCallback(
    (address: string): void => commitAddress(address, true),
    [commitAddress]
  )

  const removeCustomAddress = useCallback(
    (address: string): void => {
      const nextCustomAddresses = removeMobilePairingCustomAddress(
        customAddressesRef.current,
        address
      )
      if (haveSameAddresses(nextCustomAddresses, customAddressesRef.current)) {
        return
      }
      customAddressesRef.current = nextCustomAddresses
      setCustomAddresses(nextCustomAddresses)
      const removingSelection =
        selectedAddressIsManualRef.current && selectedAddressRef.current === address
      if (!removingSelection) {
        void updateSettings({ mobilePairingCustomAddresses: nextCustomAddresses })
        return
      }
      const nextAddress = selectRefreshedNetworkAddress(undefined, networkInterfaces)
      const addressChanged = selectedAddressRef.current !== nextAddress
      selectedAddressRef.current = nextAddress
      selectedAddressIsManualRef.current = false
      selectedAddressWasExplicitlySelectedRef.current = false
      setSelectedAddress(nextAddress)
      setSelectedAddressIsCustom(false)
      pendingCustomAddressWritesRef.current.push(undefined)
      void updateSettings({
        mobilePairingCustomAddress: null,
        mobilePairingCustomAddresses: nextCustomAddresses
      })
      if (addressChanged) {
        onSelectionInvalidated({ address: nextAddress, source: 'user' })
      }
    },
    [networkInterfaces, onSelectionInvalidated, updateSettings]
  )

  useEffect(() => {
    if (savedCustomAddress === observedCustomAddressRef.current) {
      return
    }
    observedCustomAddressRef.current = savedCustomAddress
    const pendingWrites = pendingCustomAddressWritesRef.current
    const acknowledgedWriteIndex = pendingWrites.indexOf(savedCustomAddress)
    if (acknowledgedWriteIndex !== -1) {
      pendingWrites.splice(0, acknowledgedWriteIndex + 1)
      return
    }
    pendingWrites.length = 0
    const nextAddress =
      savedCustomAddress ?? selectRefreshedNetworkAddress(undefined, networkInterfaces)
    const addressChanged = selectedAddressRef.current !== nextAddress
    selectedAddressRef.current = nextAddress
    selectedAddressIsManualRef.current = savedCustomAddress !== undefined
    selectedAddressWasExplicitlySelectedRef.current = savedCustomAddress !== undefined
    setSelectedAddress(nextAddress)
    setSelectedAddressIsCustom(savedCustomAddress !== undefined)
    if (addressChanged) {
      onSelectionInvalidated({ address: nextAddress, source: 'external' })
    }
  }, [networkInterfaces, onSelectionInvalidated, savedCustomAddress])

  useEffect(() => {
    if (pendingCustomAddressWritesRef.current.length > 0) {
      return
    }
    if (haveSameAddresses(savedCustomAddresses, customAddressesRef.current)) {
      return
    }
    customAddressesRef.current = savedCustomAddresses
    setCustomAddresses(savedCustomAddresses)
  }, [savedCustomAddresses])

  return {
    selectedAddress,
    selectedAddressIsCustom,
    customAddresses,
    selectAddress,
    selectCustomAddress,
    removeCustomAddress,
    selectAddressAfterRefresh
  }
}
