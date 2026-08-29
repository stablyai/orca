import { describe, it, expect } from 'vitest'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'

const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
const TAILNET: MobileNetworkInterface = { name: 'tailscale0', address: '100.64.1.20' }
const BRIDGE: MobileNetworkInterface = { name: 'docker0', address: '172.17.0.1' }
const DEFAULT_SWITCH: MobileNetworkInterface = {
  name: 'vEthernet (Default Switch)',
  address: '172.28.80.1',
  hasDefaultRoute: true
}
const WSL_SWITCH: MobileNetworkInterface = {
  name: 'vEthernet (WSL (Hyper-V firewall))',
  address: '172.20.96.1',
  hasDefaultRoute: true
}
const EXTERNAL_SWITCH: MobileNetworkInterface = {
  name: 'vEthernet (Lab)',
  address: '192.168.1.30',
  hasDefaultRoute: true
}

describe('selectRefreshedNetworkAddress', () => {
  // Why: regression for the manual-address branch the PR adds — a
  // transient empty refresh must not clobber the user's typed address.
  it('keeps a manual address when refresh returns no interfaces', () => {
    expect(selectRefreshedNetworkAddress('my-mac.ts.net', [], true)).toBe('my-mac.ts.net')
  })

  // Existing behavior is preserved verbatim from the spec.
  it('keeps the selected address when refresh discovers a new tailnet interface', () => {
    expect(selectRefreshedNetworkAddress(LAN.address, [LAN, TAILNET])).toBe(LAN.address)
  })

  it('selects the first refreshed interface when there is no current address', () => {
    expect(selectRefreshedNetworkAddress(undefined, [TAILNET, LAN])).toBe(TAILNET.address)
  })

  it('prefers a tailnet address when no address is selected yet', () => {
    expect(selectRefreshedNetworkAddress(undefined, [LAN, TAILNET])).toBe(TAILNET.address)
  })

  it('moves to the first refreshed interface when the current address disappeared', () => {
    expect(selectRefreshedNetworkAddress('10.0.0.4', [TAILNET, LAN])).toBe(TAILNET.address)
  })

  it('moves to a tailnet address when the current address disappeared', () => {
    expect(selectRefreshedNetworkAddress('10.0.0.4', [LAN, TAILNET])).toBe(TAILNET.address)
  })

  it('clears the selection when no interfaces are available', () => {
    expect(selectRefreshedNetworkAddress(LAN.address, [])).toBeUndefined()
  })

  it.each([BRIDGE, DEFAULT_SWITCH])(
    'keeps the explicitly selected $name adapter when refresh is empty',
    (networkInterface) => {
      expect(selectRefreshedNetworkAddress(networkInterface.address, [], false, true)).toBe(
        networkInterface.address
      )
    }
  )

  it('skips a container bridge in favor of a reachable address', () => {
    expect(selectRefreshedNetworkAddress(undefined, [BRIDGE, LAN])).toBe(LAN.address)
  })

  it('skips route-positive Default Switch and WSL addresses in favor of LAN', () => {
    expect(selectRefreshedNetworkAddress(undefined, [DEFAULT_SWITCH, WSL_SWITCH, LAN])).toBe(
      LAN.address
    )
  })

  it('reclassifies a stale auto-selected Default Switch address', () => {
    expect(selectRefreshedNetworkAddress(DEFAULT_SWITCH.address, [DEFAULT_SWITCH, LAN])).toBe(
      LAN.address
    )
  })

  it('reclassifies a stale auto-selected WSL address', () => {
    expect(selectRefreshedNetworkAddress(WSL_SWITCH.address, [WSL_SWITCH, LAN])).toBe(LAN.address)
  })

  it('drops an auto-selected vEthernet address when route evidence becomes ambiguous', () => {
    expect(
      selectRefreshedNetworkAddress(EXTERNAL_SWITCH.address, [
        { ...EXTERNAL_SWITCH, hasDefaultRoute: undefined }
      ])
    ).toBeUndefined()
  })

  // Why: matches main's default — advertising nothing beats advertising docker0, and Relay
  // pairs without a direct address. A divergence here would show an address the QR never carried.
  it('selects no address when every interface is a container bridge', () => {
    expect(selectRefreshedNetworkAddress(undefined, [BRIDGE])).toBeUndefined()
  })

  it('keeps a bridge the user picked explicitly', () => {
    expect(selectRefreshedNetworkAddress(BRIDGE.address, [BRIDGE, LAN], false, true)).toBe(
      BRIDGE.address
    )
  })

  it.each([DEFAULT_SWITCH, WSL_SWITCH])(
    'keeps the explicitly selected known host-local adapter $name',
    (networkInterface) => {
      expect(
        selectRefreshedNetworkAddress(
          networkInterface.address,
          [networkInterface, LAN],
          false,
          true
        )
      ).toBe(networkInterface.address)
    }
  )
})
