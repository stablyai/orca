import {
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress,
  type PairingNetworkInterface
} from '../../../../../shared/pairing-address-auto-selection'

export function selectRefreshedNetworkAddress(
  currentAddress: string | undefined,
  interfaces: readonly PairingNetworkInterface[],
  // Preserve explicitly manual addresses through refresh instead of snapping to discovered tailnet/LAN defaults.
  currentAddressIsManual: boolean = false,
  currentAddressWasExplicitlySelected: boolean = false
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
  const currentInterface = interfaces.find((iface) => iface.address === currentAddress)
  if (
    currentInterface &&
    (currentAddressWasExplicitlySelected ||
      !isVirtualBridgeInterface(currentInterface.name, currentInterface.hasDefaultRoute))
  ) {
    return currentAddress
  }
  // Share main’s default so picker/QR agree; bridge-only hosts omit direct addresses and pair through Relay.
  return selectAutoAdvertisedPairingAddress(interfaces)
}
