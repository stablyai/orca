import { describe, expect, it } from 'vitest'
import { describeNetworkAddress } from './network-address-label'
import { getRuntimeServerProblemLine } from './runtime-server-row-meta'

const quietRow = {
  accessRevoked: false,
  problem: 'Timed out waiting for the remote Orca runtime.',
  probeFailed: true,
  compatibilityBlocked: false
}

describe('runtime server problem line', () => {
  it('says when an unreachable server was last seen instead of repeating the failure', () => {
    const now = Date.UTC(2026, 9, 20)
    expect(
      getRuntimeServerProblemLine({
        environment: { lastUsedAt: now - 3 * 86_400_000 },
        row: quietRow,
        remoteUpdate: undefined,
        managedStatusError: null,
        managedSummary: null,
        address: '100.88.12.5:6768',
        now
      })
    ).toEqual({ text: 'Last seen 3 days ago · 100.88.12.5:6768', destructive: false })
  })

  it('says a server was never connected rather than still waiting', () => {
    expect(
      getRuntimeServerProblemLine({
        environment: { lastUsedAt: null },
        row: quietRow,
        remoteUpdate: undefined,
        managedStatusError: null,
        managedSummary: null,
        address: '100.88.12.5:6768'
      })?.text
    ).toBe('Never connected · 100.88.12.5:6768')
  })
})

describe('a server paired twice', () => {
  it('names the twin ahead of reachability, since one entry must go', () => {
    expect(
      getRuntimeServerProblemLine({
        environment: { lastUsedAt: null },
        row: quietRow,
        remoteUpdate: undefined,
        managedStatusError: null,
        managedSummary: null,
        address: '100.88.12.5:6768',
        duplicateOfNames: ['Studio relay']
      })
    ).toEqual({
      text: 'Same server as Studio relay, paired twice. Remove one so its projects can be edited.',
      destructive: true
    })
  })
})

describe('network address label', () => {
  it('names Tailscale and LAN addresses instead of the interface', () => {
    expect(describeNetworkAddress('utun6', '100.108.226.109')).toBe('Tailscale · 100.108.226.109')
    expect(describeNetworkAddress('en0', '192.168.1.20')).toBe('Local network · 192.168.1.20')
    expect(describeNetworkAddress('eth0', '203.0.113.5')).toBe('eth0 · 203.0.113.5')
  })
})
