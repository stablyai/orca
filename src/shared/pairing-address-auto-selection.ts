import { isTailnetIPv4Address } from './tailnet-address'

export type PairingNetworkInterface = {
  name: string
  address: string
  hasDefaultRoute?: boolean
}

// Why: known bridge labels are host-local, while vEthernet needs positive route evidence because
// External Switch management adapters are reachable; subnets overlap real corporate LANs.
const VIRTUAL_BRIDGE_INTERFACE_PATTERN =
  /^(?:docker|br-|virbr|vmnet|vboxnet|veth|lxcbr|cni|flannel|cali|bridge)|VMware Network Adapter|VirtualBox Host-Only/i
const HYPER_V_INTERFACE_PATTERN = /^vEthernet /i
const HOST_LOCAL_HYPER_V_INTERFACE_PATTERN =
  /^vEthernet \((?:Default Switch|WSL(?: \(Hyper-V firewall\))?)\)$/i

export function isVirtualBridgeInterface(name: string, hasDefaultRoute?: boolean): boolean {
  if (HOST_LOCAL_HYPER_V_INTERFACE_PATTERN.test(name)) {
    return true
  }
  if (HYPER_V_INTERFACE_PATTERN.test(name)) {
    return hasDefaultRoute !== true
  }
  return VIRTUAL_BRIDGE_INTERFACE_PATTERN.test(name)
}

// Why: main mints the QR from this and the renderer's picker shows its result, so both sides must
// agree — a divergence would display one address while the QR advertises another. Bridges stay
// pickable for an explicit choice but are never chosen here; `undefined` means "advertise no direct
// address", which Relay tolerates (it carries its own invite) and the LAN-only path refuses.
export function selectAutoAdvertisedPairingAddress(
  interfaces: readonly PairingNetworkInterface[]
): string | undefined {
  const advertisable = interfaces.filter(
    (iface) => !isVirtualBridgeInterface(iface.name, iface.hasDefaultRoute)
  )
  return (
    advertisable.find((iface) => isTailnetIPv4Address(iface.address))?.address ??
    advertisable[0]?.address
  )
}
