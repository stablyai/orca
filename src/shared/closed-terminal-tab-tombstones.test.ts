import { describe, expect, it } from 'vitest'
import {
  CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS,
  MAX_CLOSED_TERMINAL_TAB_TOMBSTONES,
  closedTerminalTabTombstoneSchema,
  isTerminalWorkspaceEmptiedOnPurpose,
  pruneClosedTerminalTabTombstones,
  recordClosedTerminalTabTombstone,
  type ClosedTerminalTabTombstonesByTabId
} from './closed-terminal-tab-tombstones'

const NOW = 1_800_000_000_000
const WT = 'repo-1::/srv/app'

describe('closed terminal tab records', () => {
  it('records the closing worktree, reason and time', () => {
    expect(
      recordClosedTerminalTabTombstone({}, 'tab-1', { worktreeId: WT, reason: 'cleanup' }, NOW)
    ).toEqual({ 'tab-1': { closedAt: NOW, worktreeId: WT, reason: 'cleanup' } })
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

  it('reads an older build record as a close, and an unknown reason as no reason', () => {
    expect(closedTerminalTabTombstoneSchema.parse({ closedAt: 1, worktreeId: WT })).toEqual({
      closedAt: 1,
      worktreeId: WT
    })
    expect(
      closedTerminalTabTombstoneSchema.parse({ closedAt: 1, worktreeId: WT, reason: 'later' })
    ).toEqual({ closedAt: 1, worktreeId: WT, reason: undefined })
  })
})

describe('emptied on purpose', () => {
  const closed: ClosedTerminalTabTombstonesByTabId = { 'tab-1': { closedAt: NOW, worktreeId: WT } }

  it('an empty row with a close record in that workspace was emptied on purpose', () => {
    expect(
      isTerminalWorkspaceEmptiedOnPurpose(
        { tabsByWorktree: { [WT]: [] }, closedTerminalTabTombstonesByTabId: closed },
        WT
      )
    ).toBe(true)
  })

  it('an empty row with no record is unknown, as is a missing row', () => {
    expect(isTerminalWorkspaceEmptiedOnPurpose({ tabsByWorktree: { [WT]: [] } }, WT)).toBe(false)
    expect(
      isTerminalWorkspaceEmptiedOnPurpose(
        { tabsByWorktree: {}, closedTerminalTabTombstonesByTabId: closed },
        WT
      )
    ).toBe(false)
  })

  it('a record for another workspace does not count', () => {
    expect(
      isTerminalWorkspaceEmptiedOnPurpose(
        { tabsByWorktree: { other: [] }, closedTerminalTabTombstonesByTabId: closed },
        'other'
      )
    ).toBe(false)
  })
})
