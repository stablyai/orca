import { describe, expect, it } from 'vitest'
import {
  CLOSED_TAB_TOMBSTONE_TTL_MS,
  MAX_CLOSED_TAB_TOMBSTONES,
  mergeClosedTerminalTabTombstones,
  pruneClosedTerminalTabTombstones,
  recordClosedTerminalTabTombstone
} from './closed-terminal-tab-tombstones'

const NOW = 1_800_000_000_000

describe('closed terminal tab tombstones', () => {
  it('records a tombstone with the closing worktree and timestamp', () => {
    const map = recordClosedTerminalTabTombstone({}, 'tab-1', 'wt-1', NOW)
    expect(map).toEqual({ 'tab-1': { closedAt: NOW, worktreeId: 'wt-1' } })
  })

  it('merge keeps the union and the newer closedAt per tab id', () => {
    const a = { 'tab-1': { closedAt: NOW - 1000, worktreeId: 'wt-1' } }
    const b = {
      'tab-1': { closedAt: NOW, worktreeId: 'wt-1' },
      'tab-2': { closedAt: NOW - 500, worktreeId: 'wt-2' }
    }
    expect(mergeClosedTerminalTabTombstones(a, b, NOW)).toEqual({
      'tab-1': { closedAt: NOW, worktreeId: 'wt-1' },
      'tab-2': { closedAt: NOW - 500, worktreeId: 'wt-2' }
    })
  })

  it('prune drops entries older than the TTL', () => {
    const map = {
      fresh: { closedAt: NOW - 1000, worktreeId: 'wt-1' },
      stale: { closedAt: NOW - CLOSED_TAB_TOMBSTONE_TTL_MS - 1, worktreeId: 'wt-1' }
    }
    expect(pruneClosedTerminalTabTombstones(map, NOW)).toEqual({
      fresh: { closedAt: NOW - 1000, worktreeId: 'wt-1' }
    })
  })

  it('prune caps the map at the newest MAX entries', () => {
    const map = Object.fromEntries(
      Array.from({ length: MAX_CLOSED_TAB_TOMBSTONES + 10 }, (_, i) => [
        `tab-${i}`,
        { closedAt: NOW - i, worktreeId: 'wt-1' }
      ])
    )
    const pruned = pruneClosedTerminalTabTombstones(map, NOW)
    expect(Object.keys(pruned)).toHaveLength(MAX_CLOSED_TAB_TOMBSTONES)
    expect(pruned['tab-0']).toBeDefined()
    expect(pruned[`tab-${MAX_CLOSED_TAB_TOMBSTONES + 9}`]).toBeUndefined()
  })

  it('merge tolerates undefined inputs', () => {
    expect(mergeClosedTerminalTabTombstones(undefined, undefined, NOW)).toEqual({})
  })
})
