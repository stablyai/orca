import { describe, expect, it } from 'vitest'
import type { PeerHostConnection } from '@/components/peer-collab/use-peer-collab-client-connection'
import {
  applyPeersTabOrder,
  buildPeersFlatTabs,
  peersFlatTabKey,
  resolveAdjacentPeersTab,
  resolvePeersTabByIndex
} from './peers-flat-tab-list'

function host(overrides: Partial<PeerHostConnection>): PeerHostConnection {
  return {
    hostId: 'host-a',
    endpoint: '10.0.0.1:9000',
    status: { state: 'connected' } as PeerHostConnection['status'],
    terminals: [],
    ...overrides
  }
}

describe('buildPeersFlatTabs', () => {
  it('flattens terminals across hosts in order, marking each host boundary', () => {
    const hosts: PeerHostConnection[] = [
      host({
        hostId: 'host-a',
        terminals: [
          { handle: 'a1', title: 'Shell' },
          { handle: 'a2', title: 'Server' }
        ] as PeerHostConnection['terminals']
      }),
      host({
        hostId: 'host-b',
        endpoint: '10.0.0.2:9000',
        terminals: [{ handle: 'b1', title: 'Build' }] as PeerHostConnection['terminals']
      })
    ]

    const flat = buildPeersFlatTabs(hosts)

    expect(flat.map((tab) => tab.handle)).toEqual(['a1', 'a2', 'b1'])
    expect(flat.map((tab) => tab.isFirstOfHost)).toEqual([true, false, true])
    expect(flat[2].hostLabel).toBe('10.0.0.2:9000')
  })

  it('excludes hosts that are not connected', () => {
    const hosts: PeerHostConnection[] = [
      host({
        hostId: 'host-a',
        status: { state: 'reconnect-wait' } as PeerHostConnection['status'],
        terminals: [{ handle: 'a1', title: 'Shell' }] as PeerHostConnection['terminals']
      })
    ]

    expect(buildPeersFlatTabs(hosts)).toEqual([])
  })
})

describe('resolvePeersTabByIndex', () => {
  it('returns the nth tab or null out of range', () => {
    const tabs = buildPeersFlatTabs([
      host({
        terminals: [
          { handle: 'a1', title: 'A' },
          { handle: 'a2', title: 'B' }
        ] as PeerHostConnection['terminals']
      })
    ])

    expect(resolvePeersTabByIndex(tabs, 1)?.handle).toBe('a2')
    expect(resolvePeersTabByIndex(tabs, 9)).toBeNull()
  })
})

describe('resolveAdjacentPeersTab', () => {
  const tabs = buildPeersFlatTabs([
    host({
      terminals: [
        { handle: 'a1', title: 'A' },
        { handle: 'a2', title: 'B' },
        { handle: 'a3', title: 'C' }
      ] as PeerHostConnection['terminals']
    })
  ])

  it('steps forward and wraps past the last tab', () => {
    expect(resolveAdjacentPeersTab(tabs, peersFlatTabKey(tabs[2]), 1)?.handle).toBe('a1')
  })

  it('steps backward and wraps past the first tab', () => {
    expect(resolveAdjacentPeersTab(tabs, peersFlatTabKey(tabs[0]), -1)?.handle).toBe('a3')
  })

  it('defaults to the first tab when nothing is active', () => {
    expect(resolveAdjacentPeersTab(tabs, null, 1)?.handle).toBe('a1')
  })

  it('returns null when the list is empty', () => {
    expect(resolveAdjacentPeersTab([], null, 1)).toBeNull()
  })

  it('applies a saved handle order and appends unknown handles at the end', () => {
    const tabs = buildPeersFlatTabs([
      host({
        hostId: 'host-a',
        terminals: [
          { handle: 't1', title: 'One' },
          { handle: 't2', title: 'Two' },
          { handle: 't3', title: 'Three' }
        ] as PeerHostConnection['terminals']
      })
    ])

    const ordered = applyPeersTabOrder(tabs, ['t3', 't1'])

    expect(ordered.map((tab) => tab.handle)).toEqual(['t3', 't1', 't2'])
    expect(applyPeersTabOrder(tabs, undefined).map((tab) => tab.handle)).toEqual(['t1', 't2', 't3'])
  })
})
