import { describe, expect, it } from 'vitest'
import {
  isThunderboltBridgeInterface,
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress,
  type PairingNetworkInterface
} from './pairing-address-auto-selection'

const EXTERNAL_SWITCH = {
  name: 'vEthernet (Production LAN)',
  address: '192.168.50.24',
  hasDefaultRoute: true
} satisfies PairingNetworkInterface & { hasDefaultRoute: boolean }
const DEFAULT_SWITCH: PairingNetworkInterface = {
  name: 'vEthernet (Default Switch)',
  address: '172.28.80.1',
  hasDefaultRoute: true
}
const WSL_SWITCH: PairingNetworkInterface = {
  name: 'vEthernet (WSL (Hyper-V firewall))',
  address: '172.20.96.1',
  hasDefaultRoute: true
}
const PHYSICAL_LAN: PairingNetworkInterface = {
  name: 'Ethernet',
  address: '192.168.50.25'
}
const HOST_LOCAL_BRIDGE: PairingNetworkInterface = {
  name: 'docker0',
  address: '172.17.0.1'
}
const AMBIGUOUS_SWITCH: PairingNetworkInterface = {
  name: 'vEthernet (Lab)',
  address: '10.40.0.1'
}

describe('selectAutoAdvertisedPairingAddress', () => {
  it('allows a reachable Hyper-V external-switch management address', () => {
    expect(selectAutoAdvertisedPairingAddress([EXTERNAL_SWITCH])).toBe(EXTERNAL_SWITCH.address)
  })

  it('selects a physical address while filtering Default Switch, WSL, and host-local bridges', () => {
    expect(
      selectAutoAdvertisedPairingAddress([
        DEFAULT_SWITCH,
        WSL_SWITCH,
        HOST_LOCAL_BRIDGE,
        PHYSICAL_LAN
      ])
    ).toBe(PHYSICAL_LAN.address)
  })

  it('filters a vEthernet adapter when route reachability is ambiguous', () => {
    expect(selectAutoAdvertisedPairingAddress([AMBIGUOUS_SWITCH])).toBeUndefined()
  })

  it('keeps Thunderbolt Bridge explicit-only outside Share this host', () => {
    expect(isThunderboltBridgeInterface('bridge0', 'darwin')).toBe(true)
    expect(isThunderboltBridgeInterface('Bridge12', 'darwin')).toBe(true)
    expect(isVirtualBridgeInterface('bridge0')).toBe(true)
    expect(isVirtualBridgeInterface('bridge1')).toBe(true)
    expect(isVirtualBridgeInterface('bridge')).toBe(true)
    expect(isVirtualBridgeInterface('br-lan')).toBe(true)
    expect(isVirtualBridgeInterface('docker0')).toBe(true)
    expect(
      selectAutoAdvertisedPairingAddress([{ name: 'bridge0', address: '10.99.88.1' }])
    ).toBeUndefined()
  })

  it('keeps a Linux bridge0 out of the direct pairing address', () => {
    const linuxBridge = { name: 'bridge0', address: '10.0.0.1' }
    const lan = { name: 'eth0', address: '192.168.4.191' }
    expect(isThunderboltBridgeInterface('bridge0', 'linux')).toBe(false)
    expect(isVirtualBridgeInterface('bridge0')).toBe(true)
    expect(selectAutoAdvertisedPairingAddress([linuxBridge])).toBeUndefined()
    expect(selectAutoAdvertisedPairingAddress([linuxBridge, lan])).toBe(lan.address)
  })

  it('prefers LAN and tailnet while keeping Thunderbolt out of automatic pairing addresses', () => {
    const thunderbolt = { name: 'bridge0', address: '10.99.88.1' }
    const lan = { name: 'en0', address: '192.168.4.191' }
    const tailnet = { name: 'tailscale0', address: '100.64.1.20' }
    expect(selectAutoAdvertisedPairingAddress([thunderbolt, lan])).toBe(lan.address)
    expect(selectAutoAdvertisedPairingAddress([thunderbolt, tailnet])).toBe(tailnet.address)
    expect(selectAutoAdvertisedPairingAddress([HOST_LOCAL_BRIDGE, thunderbolt])).toBeUndefined()
  })

  it.each([
    'vEthernet (Default Switch)',
    'vEthernet (default switch)',
    'vEthernet (WSL)',
    'vEthernet (WSL (Hyper-V firewall))'
  ])('keeps the known host-local %s label filtered with a default route', (name) => {
    expect(isVirtualBridgeInterface(name, true)).toBe(true)
  })

  it.each([
    'vEthernet (Default Switchboard)',
    'vEthernet (WSL-LAN)',
    'vEthernet (WSL LAN)',
    'vEthernet (WSL External)'
  ])('does not treat the route-backed near-match %s as a known host-local label', (name) => {
    expect(isVirtualBridgeInterface(name, true)).toBe(false)
  })

  it.each([
    ['external', EXTERNAL_SWITCH, false],
    ['Default Switch', DEFAULT_SWITCH, true],
    ['WSL', WSL_SWITCH, true],
    ['physical', PHYSICAL_LAN, false],
    ['host-local', HOST_LOCAL_BRIDGE, true],
    ['ambiguous', AMBIGUOUS_SWITCH, true]
  ] as const)('classifies the %s fixture', (_label, fixture, expected) => {
    expect(isVirtualBridgeInterface(fixture.name, fixture.hasDefaultRoute)).toBe(expected)
  })
})
