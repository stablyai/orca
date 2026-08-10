import { describe, expect, it } from 'vitest'
import type { DetectedPort } from './ssh-types'
import {
  filterSshAutoForwardCandidates,
  isSshAutoForwardOwnedPort,
  shouldIncludeSshDetectedPortInPanel,
  sshDetectedPortOwnershipFilteringActive
} from './ssh-detected-port-ownership'

function port(overrides: Partial<DetectedPort> & Pick<DetectedPort, 'port'>): DetectedPort {
  return {
    host: '127.0.0.1',
    ...overrides
  }
}

describe('sshDetectedPortOwnershipFilteringActive', () => {
  it('is inactive for old-relay / Windows payloads without ownership fields', () => {
    expect(
      sshDetectedPortOwnershipFilteringActive([
        port({ port: 3000 }),
        port({ port: 3001, processName: 'node' })
      ])
    ).toBe(false)
  })

  it('is active when any row carries ownedByConnectingUser', () => {
    expect(
      sshDetectedPortOwnershipFilteringActive([
        port({ port: 3000 }),
        port({ port: 3001, ownedByConnectingUser: true })
      ])
    ).toBe(true)
  })
})

describe('shouldIncludeSshDetectedPortInPanel', () => {
  it('shows all ports when ownership filtering is inactive', () => {
    expect(
      shouldIncludeSshDetectedPortInPanel(port({ port: 3000, ownedByConnectingUser: false }), {
        showOtherUsers: false,
        ownershipFilteringActive: false
      })
    ).toBe(true)
  })

  it('defaults to owned ports only; toggle reveals others', () => {
    const owned = port({ port: 3000, ownedByConnectingUser: true })
    const other = port({ port: 3001, ownedByConnectingUser: false, username: 'bob' })

    expect(
      shouldIncludeSshDetectedPortInPanel(owned, {
        showOtherUsers: false,
        ownershipFilteringActive: true
      })
    ).toBe(true)
    expect(
      shouldIncludeSshDetectedPortInPanel(other, {
        showOtherUsers: false,
        ownershipFilteringActive: true
      })
    ).toBe(false)
    expect(
      shouldIncludeSshDetectedPortInPanel(other, {
        showOtherUsers: true,
        ownershipFilteringActive: true
      })
    ).toBe(true)
  })

  it('never hides ports with an advertised URL from the user terminal', () => {
    expect(
      shouldIncludeSshDetectedPortInPanel(
        {
          ...port({ port: 3000, ownedByConnectingUser: false }),
          advertisedUrl: 'https://app.local:3000'
        },
        { showOtherUsers: false, ownershipFilteringActive: true }
      )
    ).toBe(true)
  })
})

describe('filterSshAutoForwardCandidates', () => {
  it('ignores non-owned ports and initial-scan keys', () => {
    const ports: DetectedPort[] = [
      port({ port: 3000, ownedByConnectingUser: true }),
      port({ port: 3001, ownedByConnectingUser: false }),
      port({ port: 3002, ownedByConnectingUser: true }),
      // Old relay / Windows: ownership unset still eligible (unfiltered degrade)
      port({ port: 3003 })
    ]
    const initial = new Set(['127.0.0.1:3000'])

    expect(filterSshAutoForwardCandidates(ports, initial).map((p) => p.port)).toEqual([3002, 3003])
  })

  it('treats ownedByConnectingUser === false as ineligible', () => {
    expect(isSshAutoForwardOwnedPort({ ownedByConnectingUser: false })).toBe(false)
    expect(isSshAutoForwardOwnedPort({ ownedByConnectingUser: true })).toBe(true)
    expect(isSshAutoForwardOwnedPort({})).toBe(true)
  })
})
