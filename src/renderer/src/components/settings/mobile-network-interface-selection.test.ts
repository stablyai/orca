import { describe, it, expect } from 'vitest'
import {
  buildComboboxEntries,
  selectRefreshedNetworkAddress,
  type MobileNetworkInterface
} from './mobile-network-interface-selection'

const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
const TAILNET: MobileNetworkInterface = { name: 'tailscale0', address: '100.64.1.20' }

describe('buildComboboxEntries', () => {
  it('returns only interface entries when query is empty', () => {
    const entries = buildComboboxEntries([LAN, TAILNET], '')
    expect(entries).toEqual([
      { kind: 'interface', iface: LAN },
      { kind: 'interface', iface: TAILNET }
    ])
  })

  it('filters interfaces by substring on address or name (case-insensitive)', () => {
    const entries = buildComboboxEntries([LAN, TAILNET], 'TAIL')
    expect(entries).toEqual([{ kind: 'interface', iface: TAILNET }])
  })

  it('appends a use-query entry when the query is a valid address not in the list', () => {
    const entries = buildComboboxEntries([LAN, TAILNET], 'my-mac.tail-abcd.ts.net')
    expect(entries).toEqual([
      { kind: 'interface', iface: LAN },
      { kind: 'interface', iface: TAILNET },
      { kind: 'use-query', address: 'my-mac.tail-abcd.ts.net' }
    ])
  })

  it('suppresses use-query when query equals an existing interface address', () => {
    const entries = buildComboboxEntries([LAN, TAILNET], '100.64.1.20')
    expect(entries).toEqual([
      { kind: 'interface', iface: LAN },
      { kind: 'interface', iface: TAILNET }
    ])
  })

  it('returns only use-query when interfaces are empty and query is valid', () => {
    const entries = buildComboboxEntries([], '1.2.3.4')
    expect(entries).toEqual([{ kind: 'use-query', address: '1.2.3.4' }])
  })

  it('omits use-query when query is invalid', () => {
    const entries = buildComboboxEntries([LAN, TAILNET], 'not-an-address')
    expect(entries).toEqual([
      { kind: 'interface', iface: LAN },
      { kind: 'interface', iface: TAILNET }
    ])
  })
})

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
