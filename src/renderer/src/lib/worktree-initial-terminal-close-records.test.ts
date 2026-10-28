import { describe, expect, it } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation.test-fixture'
import {
  CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS,
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
  it('an empty row whose only record is past its TTL seeds', () => {
    expect(
      seeds({ [WT]: [] }, closedAt(Date.now() - CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS - 1))
    ).toBe(true)
  })

  // Known gap: an older close plus a later non-close empty row still reads as deliberately emptied.
  it('a stale record from an earlier close suppresses the startup seed; activation reseeds', () => {
    const earlierClose = closedAt(Date.now() - 60_000)
    expect(seeds({ [WT]: [] }, earlierClose)).toBe(false)
    expect(seeds({ [WT]: [] }, earlierClose, { reseedEmptiedWorkspace: true })).toBe(true)
  })
})
