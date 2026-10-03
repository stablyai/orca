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
  // Why: callers that explicitly know the user picked a manual address
  // (not an OS-enumerated one) pass this so the refresh path keeps their
  // selection instead of snapping back to a tailnet/LAN fallback.
  currentAddressIsManual: boolean = false,
  currentAddressWasExplicitlySelected: boolean = false,
  platform?: NodeJS.Platform
): string | undefined {
  // Why: transient discovery failure must not clobber a deliberate user choice.
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
  // Why: shared with main so the picker never shows a default the QR didn't advertise. Undefined on
  // a bridge-only host: Relay pairs without a direct address rather than offering an unreachable one.
  return selectAutoAdvertisedPairingAddress(interfaces, hostPlatform)
}
