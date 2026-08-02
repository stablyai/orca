import { describe, it, expect } from 'vitest'
import {
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'

const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
const TAILNET: MobileNetworkInterface = { name: 'tailscale0', address: '100.64.1.20' }

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
})
