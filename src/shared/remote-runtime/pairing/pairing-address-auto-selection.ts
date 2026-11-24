import { isTailnetIPv4Address } from '../../network/tailnet-address'

export type PairingNetworkInterface = {
  name: string
  address: string
  hasDefaultRoute?: boolean
}

// Why: known bridge labels are host-local, while vEthernet needs positive route evidence because
// External Switch management adapters are reachable; subnets overlap real corporate LANs.
const VIRTUAL_BRIDGE_INTERFACE_PATTERN =
  /^(?:docker|br-|virbr|vmnet|vboxnet|veth|lxcbr|cni|flannel|cali|bridge)|VMware Network Adapter|VirtualBox Host-Only/i
// Why: a full-tunnel VPN/TUN adapter can hold the default route, but a phone on the LAN cannot
// dial its synthetic subnet. Like bridges, these stay manually selectable, never auto-advertised.
// Tailscale has no name marker: macOS exposes its tailnet address on a `utun*` adapter, so the
// address check below must run first to keep that adapter advertisable.
const TUNNEL_INTERFACE_PATTERN =
  /^(?:tun|tap|utun|wintun|wireguard|wg|singbox_tun|sing-tun|clash|mihomo|meta tunnel|openvpn|nordlynx|ppp|zt)/i
const HYPER_V_INTERFACE_PATTERN = /^vEthernet /i
const HOST_LOCAL_HYPER_V_INTERFACE_PATTERN =
  /^vEthernet \((?:Default Switch|WSL(?: \(Hyper-V firewall\))?)\)$/i

export function isTunnelInterface(name: string): boolean {
  return TUNNEL_INTERFACE_PATTERN.test(name)
}

export function isVirtualBridgeInterface(name: string, hasDefaultRoute?: boolean): boolean {
  if (HOST_LOCAL_HYPER_V_INTERFACE_PATTERN.test(name)) {
    return true
  }
  if (HYPER_V_INTERFACE_PATTERN.test(name)) {
    return hasDefaultRoute !== true
  }
  return VIRTUAL_BRIDGE_INTERFACE_PATTERN.test(name)
}

/** A tailnet address always advertises; bridges do not, and are manually selectable only. Ranking must agree. */
export function isAutoAdvertisablePairingInterface(iface: PairingNetworkInterface): boolean {
  // A tailnet address is reachable from the phone regardless of adapter name; only then is it the
  // rank-0 winner the ranking assumes.
  if (isTailnetIPv4Address(iface.address)) {
    return true
  }
  return (
    !isTunnelInterface(iface.name) && !isVirtualBridgeInterface(iface.name, iface.hasDefaultRoute)
  )
}

// Share QR and picker selection to avoid advertising a different address. Bridges remain manually selectable.
// Undefined omits direct addressing: Relay carries its own invite, while LAN-only pairing refuses.
export function selectAutoAdvertisedPairingAddress(
  interfaces: readonly PairingNetworkInterface[]
): string | undefined {
  const advertisable = interfaces.filter(isAutoAdvertisablePairingInterface)
  return (
    advertisable.find((iface) => isTailnetIPv4Address(iface.address))?.address ??
    advertisable[0]?.address
  )
}
