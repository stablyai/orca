import { describe, expect, it } from 'vitest'

import { getMobilePaneSearchEntries, shouldOpenMobilePairingAddress } from './mobile-pane-search'

describe('getMobilePaneSearchEntries', () => {
  // Why: the network entries were split into their own catalog and spliced back
  // in. Search ranking breaks ties by index, so a reorder silently reranks rows.
  it('keeps Network Interface in its original catalog position', () => {
    expect(getMobilePaneSearchEntries().map((entry) => entry.title)).toEqual([
      'Mobile Pairing',
      'Connected Devices',
      'Network Interface',
      'When you leave the mobile app'
    ])
  })
})

describe('shouldOpenMobilePairingAddress', () => {
  it('stays closed for an empty or blank query', () => {
    // Why: an empty query scores as a match for every entry, so the disclosure
    // would spring open the moment Settings mounts without a search.
    expect(shouldOpenMobilePairingAddress('')).toBe(false)
    expect(shouldOpenMobilePairingAddress('   ')).toBe(false)
  })

  it('opens for queries that target the address picker', () => {
    expect(shouldOpenMobilePairingAddress('Network Interface')).toBe(true)
    expect(shouldOpenMobilePairingAddress('tailscale')).toBe(true)
    expect(shouldOpenMobilePairingAddress('  LAN  ')).toBe(true)
  })

  it('stays closed for queries aimed at other rows on the pane', () => {
    expect(shouldOpenMobilePairingAddress('qr')).toBe(false)
    expect(shouldOpenMobilePairingAddress('revoke')).toBe(false)
  })
})
