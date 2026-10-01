import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  normalizeRuntimePairingAdvertisedAddress,
  normalizeRuntimePairingAdvertisedInterfaceName,
  resolveAnotherDevicePairingAddress,
  runtimePairingLinkCache,
  selectRuntimePairingIntent,
  type RuntimePairingIntent,
  type RuntimePairingInterface
} from './runtime-pairing-link-state'

export function useRuntimePairingAdvertisedAddress(args: {
  intent: RuntimePairingIntent
  setIntent: (intent: RuntimePairingIntent) => void
  networkInterfaces: readonly RuntimePairingInterface[]
  selectedAddress: string
  setSelectedAddress: (address: string) => void
}): {
  preferredInterfaceName: string | null
  updateSelectedAddress: (address: string) => void
  updateIntent: (intent: RuntimePairingIntent) => void
} {
  const { intent, setIntent, networkInterfaces, selectedAddress, setSelectedAddress } = args
  const updateSettings = useAppStore((state) => state.updateSettings)
  const storedInterfaceName = useAppStore((state) =>
    normalizeRuntimePairingAdvertisedInterfaceName(
      state.settings?.runtimePairingAdvertisedInterfaceName
    )
  )
  const storedAddress = useAppStore((state) =>
    normalizeRuntimePairingAdvertisedAddress(state.settings?.runtimePairingAdvertisedAddress)
  )
  const preferredInterfaceName =
    runtimePairingLinkCache.advertisedInterfaceName ?? storedInterfaceName
  const preferredAddress = runtimePairingLinkCache.advertisedAddress || storedAddress

  useEffect(() => {
    if (intent !== 'another') {
      return
    }
    if (runtimePairingLinkCache.advertisedInterfaceName === null && storedInterfaceName) {
      runtimePairingLinkCache.advertisedInterfaceName = storedInterfaceName
      runtimePairingLinkCache.advertisedAddress = storedAddress
    }
    if (networkInterfaces.length === 0) {
      const restored =
        runtimePairingLinkCache.selectedAddress ||
        runtimePairingLinkCache.advertisedAddress ||
        storedAddress
      if (!selectedAddress && restored) {
        runtimePairingLinkCache.selectedAddress = restored
        setSelectedAddress(restored)
      }
      return
    }
    const preferredInterfaceNameNow =
      runtimePairingLinkCache.advertisedInterfaceName ?? storedInterfaceName
    const rememberedAddress = runtimePairingLinkCache.advertisedAddress || storedAddress
    const nextAddress = resolveAnotherDevicePairingAddress({
      interfaces: networkInterfaces,
      selectedAddress,
      preferredInterfaceName: preferredInterfaceNameNow,
      preferredAddress: rememberedAddress
    })
    const adopted = networkInterfaces.find(
      (networkInterface) =>
        networkInterface.name === preferredInterfaceNameNow &&
        networkInterface.address === nextAddress
    )
    if (adopted && rememberedAddress !== nextAddress) {
      runtimePairingLinkCache.advertisedInterfaceName = adopted.name
      runtimePairingLinkCache.advertisedAddress = nextAddress
      void updateSettings({
        runtimePairingAdvertisedInterfaceName: adopted.name,
        runtimePairingAdvertisedAddress: nextAddress
      })
    }
    if (nextAddress === selectedAddress) {
      return
    }
    runtimePairingLinkCache.selectedAddress = nextAddress
    setSelectedAddress(nextAddress)
  }, [
    intent,
    networkInterfaces,
    selectedAddress,
    setSelectedAddress,
    storedAddress,
    storedInterfaceName,
    updateSettings
  ])

  const updateSelectedAddress = (address: string): void => {
    runtimePairingLinkCache.selectedAddress = address
    setSelectedAddress(address)
    const matchedInterface = networkInterfaces.find(
      (networkInterface) => networkInterface.address === address
    )
    if (intent === 'another' && matchedInterface) {
      runtimePairingLinkCache.advertisedInterfaceName = matchedInterface.name
      runtimePairingLinkCache.advertisedAddress = address
      void updateSettings({
        runtimePairingAdvertisedInterfaceName: matchedInterface.name,
        runtimePairingAdvertisedAddress: address
      })
      return
    }
    if (intent === 'another' && !matchedInterface) {
      // Why: a down Thunderbolt interface stays in the picker as the retained address.
      // Choosing that row again is not a switch to a custom endpoint.
      if (address === preferredAddress) {
        return
      }
      runtimePairingLinkCache.customAddress = address
      runtimePairingLinkCache.intent = 'custom'
      setIntent('custom')
    } else if (intent === 'custom') {
      runtimePairingLinkCache.customAddress = address
    }
  }

  const updateIntent = (nextIntent: RuntimePairingIntent): void => {
    setIntent(nextIntent)
    setSelectedAddress(
      selectRuntimePairingIntent(
        nextIntent,
        networkInterfaces,
        runtimePairingLinkCache.customAddress,
        { preferredInterfaceName, preferredAddress }
      )
    )
  }

  return { preferredInterfaceName, updateSelectedAddress, updateIntent }
}
