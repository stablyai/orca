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
    expect(selectAutoAdvertisedPairingAddress([EXTERNAL_SWITCH], 'win32')).toBe(
      EXTERNAL_SWITCH.address
    )
  })

  it('selects a physical address while filtering Default Switch, WSL, and host-local bridges', () => {
    expect(
      selectAutoAdvertisedPairingAddress(
        [DEFAULT_SWITCH, WSL_SWITCH, HOST_LOCAL_BRIDGE, PHYSICAL_LAN],
        'win32'
      )
    ).toBe(PHYSICAL_LAN.address)
  })

  it('filters a vEthernet adapter when route reachability is ambiguous', () => {
    expect(selectAutoAdvertisedPairingAddress([AMBIGUOUS_SWITCH], 'win32')).toBeUndefined()
  })

  it('does not treat macOS Thunderbolt Bridge as a container bridge', () => {
    expect(isThunderboltBridgeInterface('bridge0', 'darwin')).toBe(true)
    expect(isThunderboltBridgeInterface('Bridge12', 'darwin')).toBe(true)
    expect(isVirtualBridgeInterface('bridge0', undefined, 'darwin')).toBe(false)
    expect(isVirtualBridgeInterface('bridge1', undefined, 'darwin')).toBe(false)
    expect(isVirtualBridgeInterface('bridge', undefined, 'darwin')).toBe(true)
    expect(isVirtualBridgeInterface('br-lan', undefined, 'darwin')).toBe(true)
    expect(isVirtualBridgeInterface('docker0', undefined, 'darwin')).toBe(true)
  })

  it('keeps a Linux bridge0 out of the direct pairing address', () => {
    const linuxBridge = { name: 'bridge0', address: '10.0.0.1' }
    const lan = { name: 'eth0', address: '192.168.4.191' }
    expect(isThunderboltBridgeInterface('bridge0', 'linux')).toBe(false)
    expect(isVirtualBridgeInterface('bridge0', undefined, 'linux')).toBe(true)
    expect(selectAutoAdvertisedPairingAddress([linuxBridge], 'linux')).toBeUndefined()
    expect(selectAutoAdvertisedPairingAddress([linuxBridge, lan], 'linux')).toBe(lan.address)
  })

  it('prefers LAN and tailnet over Thunderbolt Bridge, and uses the bridge when it is the only direct address', () => {
    const thunderbolt = { name: 'bridge0', address: '10.99.88.1' }
    const lan = { name: 'en0', address: '192.168.4.191' }
    const tailnet = { name: 'tailscale0', address: '100.64.1.20' }
    expect(selectAutoAdvertisedPairingAddress([thunderbolt, lan], 'darwin')).toBe(lan.address)
    expect(selectAutoAdvertisedPairingAddress([thunderbolt, tailnet], 'darwin')).toBe(
      tailnet.address
    )
    expect(selectAutoAdvertisedPairingAddress([HOST_LOCAL_BRIDGE, thunderbolt], 'darwin')).toBe(
      thunderbolt.address
    )
  })

  it.each([
    'vEthernet (Default Switch)',
    'vEthernet (default switch)',
    'vEthernet (WSL)',
    'vEthernet (WSL (Hyper-V firewall))'
  ])('keeps the known host-local %s label filtered with a default route', (name) => {
    expect(isVirtualBridgeInterface(name, true, 'win32')).toBe(true)
  })

  it.each([
    'vEthernet (Default Switchboard)',
    'vEthernet (WSL-LAN)',
    'vEthernet (WSL LAN)',
    'vEthernet (WSL External)'
  ])('does not treat the route-backed near-match %s as a known host-local label', (name) => {
    expect(isVirtualBridgeInterface(name, true, 'win32')).toBe(false)
  })

  it.each([
    ['external', EXTERNAL_SWITCH, false],
    ['Default Switch', DEFAULT_SWITCH, true],
    ['WSL', WSL_SWITCH, true],
    ['physical', PHYSICAL_LAN, false],
    ['host-local', HOST_LOCAL_BRIDGE, true],
    ['ambiguous', AMBIGUOUS_SWITCH, true]
  ] as const)('classifies the %s fixture', (_label, fixture, expected) => {
    expect(isVirtualBridgeInterface(fixture.name, fixture.hasDefaultRoute, 'win32')).toBe(expected)
  })
})
