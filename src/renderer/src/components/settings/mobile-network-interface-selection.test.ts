import { describe, it, expect } from 'vitest'
import {
  addAdvertiseAddress,
  capOrderedAdvertiseAddresses,
  MAX_MOBILE_ADVERTISE_ADDRESSES,
  moveAdvertiseAddress,
  orderedAdvertiseAddressesEqual,
  refreshOrderedAdvertiseAddresses,
  removeAdvertiseAddress,
  reorderAdvertiseAddresses,
  seedOrderedAdvertiseAddresses,
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'

const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
const LAN2: MobileNetworkInterface = { name: 'en1', address: '10.0.0.5' }
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

describe('seedOrderedAdvertiseAddresses', () => {
  it('seeds Tailscale then first non-tailnet', () => {
    expect(seedOrderedAdvertiseAddresses([LAN, TAILNET, LAN2])).toEqual([
      TAILNET.address,
      LAN.address
    ])
  })

  it('seeds only Tailscale when no LAN is present', () => {
    expect(seedOrderedAdvertiseAddresses([TAILNET])).toEqual([TAILNET.address])
  })

  it('seeds only the first interface when no Tailscale is present', () => {
    expect(seedOrderedAdvertiseAddresses([LAN, LAN2])).toEqual([LAN.address])
  })

  it('returns empty when discovery is empty', () => {
    expect(seedOrderedAdvertiseAddresses([])).toEqual([])
  })
})

describe('refreshOrderedAdvertiseAddresses', () => {
  it('seeds when the current list is empty', () => {
    expect(refreshOrderedAdvertiseAddresses([], [LAN, TAILNET])).toEqual([
      TAILNET.address,
      LAN.address
    ])
  })

  it('drops vanished discovered addresses but keeps order of remaining', () => {
    expect(
      refreshOrderedAdvertiseAddresses(
        [TAILNET.address, LAN.address, LAN2.address],
        [LAN, LAN2],
        [TAILNET, LAN, LAN2]
      )
    ).toEqual([LAN.address, LAN2.address])
  })

  it('keeps valid customs when discovery is empty', () => {
    expect(
      refreshOrderedAdvertiseAddresses(['my-mac.ts.net'], [], [LAN], {
        customAddresses: new Set(['my-mac.ts.net'])
      })
    ).toEqual(['my-mac.ts.net'])
  })

  it('keeps addresses absent from previous discovery as customs', () => {
    expect(
      refreshOrderedAdvertiseAddresses(
        [TAILNET.address, 'home.example.com'],
        [TAILNET, LAN],
        [TAILNET]
      )
    ).toEqual([TAILNET.address, 'home.example.com'])
  })

  it('does not auto-append newly discovered interfaces into the user order', () => {
    expect(
      refreshOrderedAdvertiseAddresses([TAILNET.address], [TAILNET, LAN, LAN2], [TAILNET])
    ).toEqual([TAILNET.address])
  })

  it('reseeds when every selected discovered address vanished and no customs remain', () => {
    expect(refreshOrderedAdvertiseAddresses([TAILNET.address], [LAN], [TAILNET])).toEqual([
      LAN.address
    ])
  })
})

describe('cap / toggle / reorder helpers', () => {
  it('caps and dedupes advertise addresses', () => {
    const input = ['a', 'b', 'a', 'c', 'd', 'e', 'f']
    expect(capOrderedAdvertiseAddresses(input)).toEqual(['a', 'b', 'c', 'd'])
    expect(capOrderedAdvertiseAddresses(input)).toHaveLength(MAX_MOBILE_ADVERTISE_ADDRESSES)
  })

  it('refuses to add past the cap', () => {
    const atCap = ['a', 'b', 'c', 'd']
    expect(addAdvertiseAddress(atCap, 'e')).toEqual(atCap)
  })

  it('refuses to remove the last address', () => {
    expect(removeAdvertiseAddress(['a'], 'a')).toEqual(['a'])
  })

  it('moves addresses up and down', () => {
    expect(moveAdvertiseAddress(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveAdvertiseAddress(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveAdvertiseAddress(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
  })

  it('reorders addresses by index for drag-and-drop', () => {
    expect(reorderAdvertiseAddresses(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(reorderAdvertiseAddresses(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(reorderAdvertiseAddresses(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })

  it('compares ordered lists', () => {
    expect(orderedAdvertiseAddressesEqual(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(orderedAdvertiseAddressesEqual(['a', 'b'], ['b', 'a'])).toBe(false)
  })
})
