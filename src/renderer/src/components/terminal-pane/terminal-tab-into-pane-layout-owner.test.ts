import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { moveTerminalTabIntoPane } from './terminal-tab-into-pane-move'
import { createJoinHarness } from './terminal-tab-into-pane-move-harness'
import { SOURCE, TARGET, WT } from './terminal-tab-into-pane-fixture'

// A layout-owner build draws every move from main's frames; the window must not start a join.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

describe('moveTerminalTabIntoPane in a layout-owner build', () => {
  it('refuses before asking main and leaves both tabs as they were', async () => {
    const h = createJoinHarness(createTestStore())

    await expect(
      moveTerminalTabIntoPane({ sourceTabId: SOURCE, targetTabId: TARGET, side: 'right' }, h.deps)
    ).resolves.toBe('refused')

    expect(h.requests).toHaveLength(0)
    expect(h.calls).toEqual([])
    expect(h.store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([SOURCE, TARGET])
  })
})
