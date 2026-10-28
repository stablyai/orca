import { describe, expect, it } from 'vitest'

import { getMobilePaneSearchEntries, shouldOpenMobilePairingAddress } from './mobile-pane-search'
import { matchesSettingsSearch } from './settings-search'

describe('getMobilePaneSearchEntries', () => {
  it('keeps the shared machine-name entry searchable from the Mobile pane', () => {
    const entries = getMobilePaneSearchEntries()

    expect(matchesSettingsSearch('machine name', entries)).toBe(true)
    expect(matchesSettingsSearch('hostname', entries)).toBe(true)
  })
})

describe('shouldOpenMobilePairingAddress', () => {
  it('stays closed for an empty or blank query', () => {
    // Blank queries match all entries; guard them to keep disclosure closed on mount.
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
