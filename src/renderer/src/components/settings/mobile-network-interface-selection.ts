import {
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress
} from '../../../../shared/pairing-address-auto-selection'

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
  currentAddressWasExplicitlySelected: boolean = false
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
  const currentInterface = interfaces.find((iface) => iface.address === currentAddress)
  if (
    currentInterface &&
    (currentAddressWasExplicitlySelected ||
      !isVirtualBridgeInterface(currentInterface.name, currentInterface.hasDefaultRoute))
  ) {
    return currentAddress
  }
  // Why: shared with main so the picker never shows a default the QR didn't advertise. Undefined on
  // a bridge-only host: Relay pairs without a direct address rather than offering an unreachable one.
  return selectAutoAdvertisedPairingAddress(interfaces)
}
