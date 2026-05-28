import { describe, expect, it } from 'vitest'
import { selectRefreshedNetworkAddress } from './mobile-network-interface-selection'

const LAN = { name: 'en0', address: '192.168.1.24' }
const TAILNET = { name: 'tailscale0', address: '100.64.1.20' }

describe('selectRefreshedNetworkAddress', () => {
  it('keeps the selected address when refresh discovers a new tailnet interface', () => {
    expect(selectRefreshedNetworkAddress(LAN.address, [LAN, TAILNET])).toBe(LAN.address)
  })

  it('selects the first refreshed interface when there is no current address', () => {
    expect(selectRefreshedNetworkAddress(undefined, [TAILNET, LAN])).toBe(TAILNET.address)
  })

  it('moves to the first refreshed interface when the current address disappeared', () => {
    expect(selectRefreshedNetworkAddress('10.0.0.4', [TAILNET, LAN])).toBe(TAILNET.address)
  })

  it('clears the selection when no interfaces are available', () => {
    expect(selectRefreshedNetworkAddress(LAN.address, [])).toBeUndefined()
  })
})
