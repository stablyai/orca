// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadMobileAdvertiseAddressOrder,
  MOBILE_ADVERTISE_ADDRESSES_STORAGE_KEY,
  saveMobileAdvertiseAddressOrder,
  deriveCustomAdvertiseAddresses
} from './mobile-advertise-address-order-store'

describe('mobile-advertise-address-order-store', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('returns null when nothing is stored', () => {
    expect(loadMobileAdvertiseAddressOrder()).toBeNull()
  })

  it('round-trips ordered addresses and customs', () => {
    saveMobileAdvertiseAddressOrder(
      ['100.64.1.20', '192.168.1.24', 'home.example.com'],
      new Set(['home.example.com'])
    )
    expect(loadMobileAdvertiseAddressOrder()).toEqual({
      addresses: ['100.64.1.20', '192.168.1.24', 'home.example.com'],
      customAddresses: ['home.example.com'],
      relayPreferenceIndex: 3
    })
  })

  it('loads a legacy plain string[] payload', () => {
    window.localStorage.setItem(
      MOBILE_ADVERTISE_ADDRESSES_STORAGE_KEY,
      JSON.stringify(['100.64.1.20', '192.168.1.24'])
    )
    expect(loadMobileAdvertiseAddressOrder()).toEqual({
      addresses: ['100.64.1.20', '192.168.1.24'],
      customAddresses: [],
      relayPreferenceIndex: 2
    })
  })

  it('caps stored addresses at four', () => {
    saveMobileAdvertiseAddressOrder(['a', 'b', 'c', 'd', 'e'])
    expect(loadMobileAdvertiseAddressOrder()?.addresses).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps storage failures from interrupting the active pairing flow', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    expect(() => saveMobileAdvertiseAddressOrder(['100.64.1.20'])).not.toThrow()
    setItem.mockRestore()
  })

  it('derives customs from known set and non-discovered selections', () => {
    const customs = deriveCustomAdvertiseAddresses(
      ['100.64.1.20', 'home.example.com', '192.168.1.24'],
      [
        { name: 'tailscale0', address: '100.64.1.20' },
        { name: 'en0', address: '192.168.1.24' }
      ],
      new Set(['home.example.com'])
    )
    expect([...customs]).toEqual(['home.example.com'])
  })
})
