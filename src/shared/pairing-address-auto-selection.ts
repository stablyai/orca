import { isTailnetIPv4Address } from './tailnet-address'

export type PairingNetworkInterface = {
  name: string
  address: string
}

// Why: container/VM bridges are host-local — a phone can never reach docker0 or
// vmnet8 — but they enumerate as ordinary non-internal IPv4, so advertising one
// makes the direct path silently lose the pairing race and every session relay.
// Keyed on interface name, not subnet: Docker's 172.16/12 pool overlaps real
// corporate LANs, so an address test would demote genuine addresses.
const VIRTUAL_BRIDGE_INTERFACE_PATTERN =
  /^(?:docker|br-|virbr|vmnet|vboxnet|veth|lxcbr|cni|flannel|cali|bridge)|^vEthernet |VMware Network Adapter|VirtualBox Host-Only/i

export function isVirtualBridgeInterface(name: string): boolean {
  return VIRTUAL_BRIDGE_INTERFACE_PATTERN.test(name)
}

// Why: main mints the QR from this and the renderer's picker shows its result, so both sides must
// agree — a divergence would display one address while the QR advertises another. Bridges stay
// pickable for an explicit choice but are never chosen here; `undefined` means "advertise no direct
// address", which Relay tolerates (it carries its own invite) and the LAN-only path refuses.
export function selectAutoAdvertisedPairingAddress(
  interfaces: readonly PairingNetworkInterface[]
): string | undefined {
  const advertisable = interfaces.filter((iface) => !isVirtualBridgeInterface(iface.name))
  return (
    advertisable.find((iface) => isTailnetIPv4Address(iface.address))?.address ??
    advertisable[0]?.address
  )
}
