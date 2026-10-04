import { describe, expect, it } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation-test-harness'
import {
  CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS,
  MAX_CLOSED_TERMINAL_TAB_TOMBSTONES,
  recordClosedTerminalTabTombstone,
  type ClosedTerminalTabTombstonesByTabId
} from '../../../shared/closed-terminal-tab-tombstones'

registerWorktreeActivationReset()

const WT = 'wt-1'

/** Startup hydration's seeding decision: no reseed opt-in, so only the row and records decide. */
function seeds(
  tabsByWorktree: Record<string, { id: string }[]>,
  closedTerminalTabTombstonesByTabId?: ClosedTerminalTabTombstonesByTabId,
  opts?: { reseedEmptiedWorkspace?: boolean }
): boolean {
  const store = createMockStore({ tabsByWorktree, closedTerminalTabTombstonesByTabId })
  ensureWorktreeHasInitialTerminal(store, WT, undefined, undefined, undefined, undefined, opts)
  return store.createTab.mock.calls.length > 0
}

function closedAt(closedAtMs: number): ClosedTerminalTabTombstonesByTabId {
  return { 'closed-tab': { closedAt: closedAtMs, worktreeId: WT, reason: 'user' } }
}

describe('seeding an empty workspace reads close records', () => {
  it('an empty row with a close record stays empty', () => {
    expect(seeds({ [WT]: [] }, closedAt(Date.now()))).toBe(false)
  })

  it('a legacy empty row with no record seeds', () => {
    expect(seeds({ [WT]: [] })).toBe(true)
  })

  it('an empty row whose only record is past its TTL seeds', () => {
    expect(
      seeds({ [WT]: [] }, closedAt(Date.now() - CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS - 1))
    ).toBe(true)
  })

  it('an empty row whose record the per-host cap evicted seeds', () => {
    const now = Date.now()
    let records = closedAt(now - 1_000)
    for (let index = 0; index < MAX_CLOSED_TERMINAL_TAB_TOMBSTONES; index += 1) {
      records = recordClosedTerminalTabTombstone(
        records,
        `other-${index}`,
        { worktreeId: 'wt-other', reason: 'user' },
        now
      )
    }
    expect(records['closed-tab']).toBeUndefined()
    expect(seeds({ [WT]: [] }, records)).toBe(true)
  })

  // Known weakness until every membership shrink is a close: an older close plus an empty row
  // written by something that is not a close still reads as emptied on purpose.
  it('a stale record from an earlier close suppresses the startup seed; activation reseeds', () => {
    const earlierClose = closedAt(Date.now() - 60_000)
    expect(seeds({ [WT]: [] }, earlierClose)).toBe(false)
    expect(seeds({ [WT]: [] }, earlierClose, { reseedEmptiedWorkspace: true })).toBe(true)
  })
})
