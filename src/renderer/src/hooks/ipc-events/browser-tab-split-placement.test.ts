import { describe, expect, it, vi } from 'vitest'
import { createBrowserTabSplitGroup } from './browser-tab-split-placement'

function buildState(activeGroupId: string | undefined) {
  return {
    unifiedTabsByWorktree: {
      wt: [
        { id: 'u-term', entityId: 'term-1', groupId: 'g-left' },
        { id: 'u-other', entityId: 'term-2', groupId: 'g-right' }
      ]
    },
    groupsByWorktree: { wt: [{ id: 'g-left' }, { id: 'g-right' }] },
    activeGroupIdByWorktree: activeGroupId ? { wt: activeGroupId } : {},
    createEmptySplitGroup: vi.fn(() => 'g-new'),
    ensureWorktreeRootGroup: vi.fn(() => 'g-root')
  }
}

describe('createBrowserTabSplitGroup', () => {
  it("splits beside the caller's terminal, not the active pane, without taking focus", () => {
    const state = buildState('g-right')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function reads only the fields built above.
    const groupId = createBrowserTabSplitGroup(state as never, 'wt', 'right', 'term-1')

    expect(groupId).toBe('g-new')
    expect(state.createEmptySplitGroup).toHaveBeenCalledWith('wt', 'g-left', 'right', {
      activate: false
    })
  })

  it('falls back to the active pane when the caller tab is unknown', () => {
    const state = buildState('g-right')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function reads only the fields built above.
    createBrowserTabSplitGroup(state as never, 'wt', 'down', 'stale-tab')

    expect(state.createEmptySplitGroup).toHaveBeenCalledWith('wt', 'g-right', 'down', {
      activate: false
    })
  })

  it('falls back to the root group when nothing else resolves', () => {
    const state = buildState(undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function reads only the fields built above.
    createBrowserTabSplitGroup(state as never, 'wt', 'left', undefined)

    expect(state.createEmptySplitGroup).toHaveBeenCalledWith('wt', 'g-root', 'left', {
      activate: false
    })
  })
})
