import { describe, expect, it } from 'vitest'
import {
  MAX_MOBILE_PAIRING_CUSTOM_ADDRESSES,
  addMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses,
  removeMobilePairingCustomAddress
} from './mobile-pairing-custom-address'

describe('normalizeMobilePairingCustomAddress', () => {
  it('keeps a valid custom address', () => {
    expect(normalizeMobilePairingCustomAddress(' 100.126.117.25:6768 ')).toBe('100.126.117.25:6768')
  })

  it.each([null, undefined, 42, '', '0.0.0.0', 'host:99999'])(
    'clears an invalid persisted value: %s',
    (value) => {
      expect(normalizeMobilePairingCustomAddress(value)).toBeNull()
    }
  )
})

describe('mobile pairing custom address collection', () => {
  it('normalizes, deduplicates, and drops invalid entries', () => {
    expect(
      normalizeMobilePairingCustomAddresses([
        ' first.example:6768 ',
        'host:99999',
        'first.example:6768',
        'second.example:6768'
      ])
    ).toEqual(['first.example:6768', 'second.example:6768'])
  })

  it('bounds persisted entries', () => {
    const addresses = Array.from(
      { length: MAX_MOBILE_PAIRING_CUSTOM_ADDRESSES + 5 },
      (_, index) => `host-${index}.example:6768`
    )
    expect(normalizeMobilePairingCustomAddresses(addresses)).toHaveLength(
      MAX_MOBILE_PAIRING_CUSTOM_ADDRESSES
    )
  })

  it('adds the newest address and removes a saved address', () => {
    expect(addMobilePairingCustomAddress(['first.example'], ' second.example ')).toEqual([
      'first.example',
      'second.example'
    ])
    expect(
      removeMobilePairingCustomAddress(['first.example', 'second.example'], 'first.example')
    ).toEqual(['second.example'])
  })
})
