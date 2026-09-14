import { describe, expect, it } from 'vitest'
import {
  CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS,
  MAX_CLOSED_TERMINAL_TAB_TOMBSTONES,
  pruneClosedTerminalTabTombstones,
  recordClosedTerminalTabTombstone,
  reconcileClosedTerminalTabTombstones,
  type ClosedTerminalTabTombstonesByTabId
} from './closed-terminal-tab-tombstones'

const NOW = 1_800_000_000_000
const WT = 'repo-1::/srv/app'

function reconcile(
  tombstones: ClosedTerminalTabTombstonesByTabId,
  args: {
    acknowledgedWorktreeIds?: string[]
    hostKnownTabIds?: string[]
    hostRevision?: number
  }
): ClosedTerminalTabTombstonesByTabId {
  return reconcileClosedTerminalTabTombstones({
    tombstones,
    acknowledgedWorktreeIds: new Set(args.acknowledgedWorktreeIds ?? [WT]),
    hostKnownTabIds: new Set(args.hostKnownTabIds ?? []),
    hostRevision: args.hostRevision,
    now: NOW
  })
}

describe('closed terminal tab tombstones', () => {
  it('records the closing worktree and time', () => {
    expect(recordClosedTerminalTabTombstone({}, 'tab-1', WT, NOW)).toEqual({
      'tab-1': { closedAt: NOW, worktreeId: WT }
    })
  })

  it('prunes past the TTL and caps at the newest entries', () => {
    expect(
      pruneClosedTerminalTabTombstones(
        {
          fresh: { closedAt: NOW - 1_000, worktreeId: WT },
          stale: { closedAt: NOW - CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS - 1, worktreeId: WT }
        },
        NOW
      )
    ).toEqual({ fresh: { closedAt: NOW - 1_000, worktreeId: WT } })

    const overflowing = Object.fromEntries(
      Array.from({ length: MAX_CLOSED_TERMINAL_TAB_TOMBSTONES + 10 }, (_, index) => [
        `tab-${index}`,
        { closedAt: NOW - index, worktreeId: WT }
      ])
    )
    const capped = pruneClosedTerminalTabTombstones(overflowing, NOW)
    expect(Object.keys(capped)).toHaveLength(MAX_CLOSED_TERMINAL_TAB_TOMBSTONES)
    expect(capped['tab-0']).toBeDefined()
    expect(capped[`tab-${MAX_CLOSED_TERMINAL_TAB_TOMBSTONES + 9}`]).toBeUndefined()
  })
})

describe('closed terminal tab tombstone acknowledgement', () => {
  const tombstones = { 'tab-1': { closedAt: NOW, worktreeId: WT } }

  it('a snapshot carrying no revision acknowledges nothing', () => {
    expect(reconcile(tombstones, { hostRevision: undefined })).toEqual(tombstones)
  })

  it('a snapshot with no row for the tombstone worktree acknowledges nothing', () => {
    const kept = reconcile(tombstones, { acknowledgedWorktreeIds: [], hostRevision: 9 })
    expect(kept['tab-1']).toEqual({ closedAt: NOW, worktreeId: WT })
  })

  it('the first omitting snapshot only stamps the revision — it could predate the close', () => {
    const kept = reconcile(tombstones, { hostRevision: 4 })
    expect(kept['tab-1']).toEqual({ closedAt: NOW, worktreeId: WT, ackRevision: 4 })
  })

  it('a strictly newer omitting snapshot retires the tombstone', () => {
    const stamped = reconcile(tombstones, { hostRevision: 4 })
    expect(reconcile(stamped, { hostRevision: 5 })['tab-1']).toBeUndefined()
  })

  it('a repeat of the same revision does not retire it', () => {
    const stamped = reconcile(tombstones, { hostRevision: 4 })
    expect(reconcile(stamped, { hostRevision: 4 })['tab-1']).toBeDefined()
  })

  it('a host that still lists the tab re-arms the watermark instead of retiring', () => {
    const stamped = reconcile(tombstones, { hostRevision: 4 })
    const stillListed = reconcile(stamped, { hostRevision: 7, hostKnownTabIds: ['tab-1'] })
    expect(stillListed['tab-1']).toEqual({ closedAt: NOW, worktreeId: WT, ackRevision: 7 })
    expect(reconcile(stillListed, { hostRevision: 7 })['tab-1']).toBeDefined()
    expect(reconcile(stillListed, { hostRevision: 8 })['tab-1']).toBeUndefined()
  })

  it('a host revision that went backwards never retires', () => {
    const stamped = reconcile(tombstones, { hostRevision: 40 })
    const rewound = reconcile(stamped, { hostRevision: 1 })
    expect(rewound['tab-1']).toEqual({ closedAt: NOW, worktreeId: WT, ackRevision: 40 })
  })

  it('a tab listed under a different worktree still counts as known to the host', () => {
    const stamped = reconcile(tombstones, { hostRevision: 4 })
    expect(
      reconcile(stamped, { hostRevision: 5, hostKnownTabIds: ['tab-1'] })['tab-1']
    ).toBeDefined()
  })
})
