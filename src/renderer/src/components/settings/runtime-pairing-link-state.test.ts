import { describe, expect, it } from 'vitest'
import {
  resolveAnotherDevicePairingAddress,
  selectRuntimePairingIntent,
  type RuntimePairingInterface
} from './runtime-pairing-link-state'

const EN0: RuntimePairingInterface = { name: 'en0', address: '192.168.4.191' }
const BRIDGE: RuntimePairingInterface = { name: 'bridge0', address: '10.99.88.1' }
const PREFERENCE = {
  preferredInterfaceName: 'bridge0',
  preferredAddress: '10.99.88.1'
}

describe('resolveAnotherDevicePairingAddress', () => {
  it('restores the saved Thunderbolt interface when it is up, ahead of Ethernet', () => {
    expect(
      resolveAnotherDevicePairingAddress({
        interfaces: [EN0, BRIDGE],
        selectedAddress: '',
        ...PREFERENCE,
        platform: 'darwin'
      })
    ).toBe(BRIDGE.address)
  })

  it('keeps the saved Thunderbolt address when the link drops and Ethernet remains', () => {
    expect(
      resolveAnotherDevicePairingAddress({
        interfaces: [EN0],
        selectedAddress: EN0.address,
        ...PREFERENCE,
        platform: 'darwin'
      })
    ).toBe(BRIDGE.address)
  })

  it('keeps the address already selected on that interface when it has more than one', () => {
    const ipv6: RuntimePairingInterface = { name: 'bridge0', address: 'fd00::1' }
    expect(
      resolveAnotherDevicePairingAddress({
        interfaces: [BRIDGE, ipv6],
        selectedAddress: ipv6.address,
        preferredInterfaceName: 'bridge0',
        preferredAddress: BRIDGE.address,
        platform: 'darwin'
      })
    ).toBe(ipv6.address)
  })

  it('auto-selects Ethernet when the user has not picked an interface', () => {
    expect(
      resolveAnotherDevicePairingAddress({
        interfaces: [BRIDGE, EN0],
        selectedAddress: '',
        preferredInterfaceName: null,
        preferredAddress: '',
        platform: 'darwin'
      })
    ).toBe(EN0.address)
  })
})

describe('selectRuntimePairingIntent', () => {
  it('returns to the saved Thunderbolt address when Another device is chosen again', () => {
    expect(selectRuntimePairingIntent('another', [EN0, BRIDGE], '', PREFERENCE, 'darwin')).toBe(
      BRIDGE.address
    )
  })

  it('does not keep loopback when switching to Another device while Thunderbolt is down', () => {
    expect(selectRuntimePairingIntent('another', [EN0], '127.0.0.1', PREFERENCE, 'darwin')).toBe(
      BRIDGE.address
    )
  })
})
