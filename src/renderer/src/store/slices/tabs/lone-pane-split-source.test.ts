import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import {
  findLonePaneSourceGroupId,
  findSplitOppositeGroupId,
  resolveAutoPlacementGroupId
} from './lone-pane-split-source'

const WT = 'repo::/wt'

function tab(id: string, groupId: string, worktreeId = WT): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function group(id: string, worktreeId = WT): TabGroup {
  return { id, worktreeId, activeTabId: null, tabOrder: [] }
}

const horizontalSplit = {
  type: 'split' as const,
  direction: 'horizontal' as const,
  ratio: 0.5,
  first: { type: 'leaf' as const, groupId: 'g1' },
  second: { type: 'leaf' as const, groupId: 'g2' }
}

const oneLeaf = {
  layoutByWorktree: { [WT]: { type: 'leaf' as const, groupId: 'g1' } },
  groupsByWorktree: { [WT]: [group('g1')] },
  unifiedTabsByWorktree: { [WT]: [tab('t1', 'g1')] },
  activeGroupIdByWorktree: { [WT]: 'g1' }
}

const twoPanes = {
  ...oneLeaf,
  groupsByWorktree: { [WT]: [group('g1'), group('g2')] },
  unifiedTabsByWorktree: { [WT]: [tab('t1', 'g1'), tab('t2', 'g2')] }
}

describe('findLonePaneSourceGroupId', () => {
  it('names the only group when the tab area shows one pane', () => {
    expect(findLonePaneSourceGroupId(oneLeaf, WT)).toBe('g1')
  })

  it('still names it when the lone pane holds several tabs', () => {
    expect(
      findLonePaneSourceGroupId(
        { ...oneLeaf, unifiedTabsByWorktree: { [WT]: [tab('t1', 'g1'), tab('t2', 'g1')] } },
        WT
      )
    ).toBe('g1')
  })

  it('redirects when the caller named the lone group itself', () => {
    expect(findLonePaneSourceGroupId(oneLeaf, WT, 'g1')).toBe('g1')
  })

  it('leaves a caller that named some other group alone', () => {
    // Why: resolveEditorOpenTargetGroupId always names a group; only "where I'm looking" is redirected.
    expect(findLonePaneSourceGroupId(oneLeaf, WT, 'gElsewhere')).toBeNull()
  })

  it('is null once the tab area is split, the ceiling of two', () => {
    expect(
      findLonePaneSourceGroupId({ ...twoPanes, layoutByWorktree: { [WT]: horizontalSplit } }, WT)
    ).toBeNull()
  })

  it('is null for a vertical split too', () => {
    expect(
      findLonePaneSourceGroupId(
        {
          ...twoPanes,
          layoutByWorktree: { [WT]: { ...horizontalSplit, direction: 'vertical' as const } }
        },
        WT
      )
    ).toBeNull()
  })

  it('is null when the only group shows nothing yet', () => {
    expect(
      findLonePaneSourceGroupId({ ...oneLeaf, unifiedTabsByWorktree: { [WT]: [] } }, WT)
    ).toBeNull()
  })

  it('does not count an orphaned runtime terminal that has no unified tab', () => {
    // createTab sweeps such rows; a split beside one would leave an empty left pane.
    expect(
      findLonePaneSourceGroupId(
        {
          ...oneLeaf,
          groupsByWorktree: { [WT]: [{ ...group('g1'), tabOrder: ['orphan'] }] },
          unifiedTabsByWorktree: { [WT]: [] }
        },
        WT
      )
    ).toBeNull()
  })

  it('falls back to the single group when no layout has been recorded', () => {
    expect(findLonePaneSourceGroupId({ ...oneLeaf, layoutByWorktree: {} }, WT)).toBe('g1')
  })

  it('is null for a worktree with no groups at all', () => {
    expect(
      findLonePaneSourceGroupId(
        {
          layoutByWorktree: {},
          groupsByWorktree: {},
          unifiedTabsByWorktree: {}
        },
        WT
      )
    ).toBeNull()
  })

  it('is null when the leaf names a group that no longer exists', () => {
    expect(findLonePaneSourceGroupId({ ...oneLeaf, groupsByWorktree: { [WT]: [] } }, WT)).toBeNull()
  })

  it('is null for the floating panel, which renders no split layout', () => {
    const fw = FLOATING_TERMINAL_WORKTREE_ID
    expect(
      findLonePaneSourceGroupId(
        {
          layoutByWorktree: { [fw]: { type: 'leaf', groupId: 'fg' } },
          groupsByWorktree: { [fw]: [group('fg', fw)] },
          unifiedTabsByWorktree: { [fw]: [tab('t1', 'fg', fw)] }
        },
        fw
      )
    ).toBeNull()
  })
})

describe('resolveAutoPlacementGroupId', () => {
  it('mints the right-hand group unfocused and silently', () => {
    // Why unfocused: a host snapshot reads an activated empty group as a terminal pane.
    // Why silent: the user did not split anything, so pane-split discovery must not fire.
    const createEmptySplitGroup = vi.fn(() => 'gNew')
    expect(resolveAutoPlacementGroupId({ ...oneLeaf, createEmptySplitGroup }, WT)).toBe('gNew')
    expect(createEmptySplitGroup).toHaveBeenCalledWith(WT, 'g1', 'right', {
      activate: false,
      recordInteraction: false
    })
  })

  it('reuses the opposite panel, minting nothing, when the area is already split', () => {
    const createEmptySplitGroup = vi.fn(() => 'gNew')
    expect(
      resolveAutoPlacementGroupId(
        { ...twoPanes, layoutByWorktree: { [WT]: horizontalSplit }, createEmptySplitGroup },
        WT
      )
    ).toBe('g2')
    expect(createEmptySplitGroup).not.toHaveBeenCalled()
  })

  describe('a browser opening into a lone browser pane', () => {
    const loneBrowser = {
      ...oneLeaf,
      groupsByWorktree: { [WT]: [{ ...group('g1'), activeTabId: 'b1' }] },
      unifiedTabsByWorktree: { [WT]: [{ ...tab('b1', 'g1'), contentType: 'browser' as const }] }
    }

    it('joins it as a tab instead of splitting', () => {
      const createEmptySplitGroup = vi.fn(() => 'gNew')
      expect(
        resolveAutoPlacementGroupId({ ...loneBrowser, createEmptySplitGroup }, WT, 'g1', 'browser')
      ).toBeNull()
      expect(createEmptySplitGroup).not.toHaveBeenCalled()
    })

    it('still opens a terminal beside it', () => {
      const createEmptySplitGroup = vi.fn(() => 'gNew')
      expect(
        resolveAutoPlacementGroupId({ ...loneBrowser, createEmptySplitGroup }, WT, 'g1', 'terminal')
      ).toBe('gNew')
    })

    it('still opens beside a lone pane whose browser is hidden behind another tab', () => {
      const createEmptySplitGroup = vi.fn(() => 'gNew')
      const hidden = {
        ...loneBrowser,
        groupsByWorktree: { [WT]: [{ ...group('g1'), activeTabId: 't1' }] },
        unifiedTabsByWorktree: {
          [WT]: [{ ...tab('b1', 'g1'), contentType: 'browser' as const }, tab('t1', 'g1')]
        }
      }
      expect(
        resolveAutoPlacementGroupId({ ...hidden, createEmptySplitGroup }, WT, undefined, 'browser')
      ).toBe('gNew')
    })
  })
})

describe('findSplitOppositeGroupId', () => {
  const split = { ...twoPanes, layoutByWorktree: { [WT]: horizontalSplit } }
  // g1 shows a terminal; g2 shows content of the given type.
  const terminalAndContent = (content: Tab['contentType']) => ({
    ...split,
    groupsByWorktree: {
      [WT]: [
        { ...group('g1'), activeTabId: 't1' },
        { ...group('g2'), activeTabId: 'c' }
      ]
    },
    unifiedTabsByWorktree: { [WT]: [tab('t1', 'g1'), { ...tab('c', 'g2'), contentType: content }] }
  })
  const focused = <S extends typeof split>(state: S, groupId: string): S => ({
    ...state,
    activeGroupIdByWorktree: { [WT]: groupId }
  })

  it('sends content from the terminal side to the content side', () => {
    expect(findSplitOppositeGroupId(terminalAndContent('editor'), WT, 'g1', 'editor')).toBe('g2')
    expect(findSplitOppositeGroupId(terminalAndContent('browser'), WT, 'g1', 'browser')).toBe('g2')
  })

  it('keeps content on the content side when that is where the user is', () => {
    // Why: no ping-pong — the next file lands beside the last one, not over the terminals.
    expect(
      findSplitOppositeGroupId(focused(terminalAndContent('editor'), 'g2'), WT, 'g2', 'editor')
    ).toBeNull()
  })

  it('lets a file cover a browser, since the browser side is the content side', () => {
    expect(findSplitOppositeGroupId(terminalAndContent('browser'), WT, 'g1', 'editor')).toBe('g2')
  })

  it('sends a terminal to the terminal side, never over content', () => {
    expect(
      findSplitOppositeGroupId(focused(terminalAndContent('browser'), 'g2'), WT, 'g2', 'terminal')
    ).toBe('g1')
    expect(findSplitOppositeGroupId(terminalAndContent('browser'), WT, 'g1', 'terminal')).toBeNull()
  })

  it('opens opposite the focused panel when both show the same kind', () => {
    // Two terminals side by side stay a supported layout.
    expect(findSplitOppositeGroupId(split, WT, undefined, 'terminal')).toBe('g2')
    expect(findSplitOppositeGroupId(split, WT, undefined, 'editor')).toBe('g2')
    expect(findSplitOppositeGroupId(focused(split, 'g2'), WT, 'g2', 'terminal')).toBe('g1')
  })

  it('fills the other panel when it is empty', () => {
    const emptyOther = { ...split, unifiedTabsByWorktree: { [WT]: [tab('t1', 'g1')] } }
    expect(findSplitOppositeGroupId(emptyOther, WT, undefined, 'terminal')).toBe('g2')
  })

  it('fills the focused panel when it is still empty', () => {
    const emptyFocus = { ...split, unifiedTabsByWorktree: { [WT]: [tab('t2', 'g2')] } }
    expect(findSplitOppositeGroupId(emptyFocus, WT)).toBeNull()
  })

  it('leaves a caller that named the unfocused panel alone', () => {
    // Why: Open to the Side and a fresh manual split name a panel on purpose.
    expect(findSplitOppositeGroupId(split, WT, 'g2')).toBeNull()
  })

  it('works for a vertical split too', () => {
    const vertical = {
      ...split,
      layoutByWorktree: { [WT]: { ...horizontalSplit, direction: 'vertical' as const } }
    }
    expect(findSplitOppositeGroupId(vertical, WT)).toBe('g2')
  })

  it('is off with one panel, three panels, or the floating panel', () => {
    expect(findSplitOppositeGroupId(oneLeaf, WT)).toBeNull()
    const three = {
      ...split,
      layoutByWorktree: {
        [WT]: {
          ...horizontalSplit,
          second: {
            ...horizontalSplit,
            first: { type: 'leaf' as const, groupId: 'g2' },
            second: { type: 'leaf' as const, groupId: 'g3' }
          }
        }
      }
    }
    expect(findSplitOppositeGroupId(three, WT)).toBeNull()
    expect(findSplitOppositeGroupId(split, FLOATING_TERMINAL_WORKTREE_ID)).toBeNull()
  })
})
