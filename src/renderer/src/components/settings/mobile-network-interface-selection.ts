import {
  isThunderboltBridgeInterface,
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress
} from '../../../../shared/pairing-address-auto-selection'
import { readPairingHostPlatform } from './read-pairing-host-platform'

export type MobileNetworkInterface = {
  name: string
  address: string
  hasDefaultRoute?: boolean
}

export function selectRefreshedNetworkAddress(
  currentAddress: string | undefined,
  interfaces: readonly MobileNetworkInterface[],
  // Preserve explicitly manual addresses through refresh instead of snapping to discovered tailnet/LAN defaults.
  currentAddressIsManual: boolean = false,
  currentAddressWasExplicitlySelected: boolean = false,
  platform?: NodeJS.Platform
): string | undefined {
  // Transient discovery failure must preserve deliberate user choices.
  if (interfaces.length === 0) {
    return currentAddressIsManual || currentAddressWasExplicitlySelected
      ? currentAddress
      : undefined
  }
  if (currentAddressIsManual) {
    return currentAddress
  }
  // Read only once classification needs a host. An empty refresh must not require it.
  const hostPlatform = platform ?? readPairingHostPlatform()
  const currentInterface = interfaces.find((iface) => iface.address === currentAddress)
  // An auto-selected Thunderbolt address is only the fallback while it is the only
  // direct link. Ethernet showing up later must replace it. An explicit pick stays.
  const autoSelectedReachableAddress =
    currentInterface !== undefined &&
    !isVirtualBridgeInterface(
      currentInterface.name,
      currentInterface.hasDefaultRoute,
      hostPlatform
    ) &&
    !isThunderboltBridgeInterface(currentInterface.name, hostPlatform)
  if (currentInterface && (currentAddressWasExplicitlySelected || autoSelectedReachableAddress)) {
    return currentAddress
  }
  // Share main’s default so picker/QR agree; bridge-only hosts omit direct addresses and pair through Relay.
  return selectAutoAdvertisedPairingAddress(interfaces, hostPlatform)
}
