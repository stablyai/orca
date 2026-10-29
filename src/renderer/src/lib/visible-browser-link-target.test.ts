import { describe, expect, it } from 'vitest'
import type { TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { makeTabGroup, makeUnifiedTab } from '../store/slices/store-test-helpers'
import { findVisibleBrowserLinkTarget } from './visible-browser-link-target'

type VisibleBrowserLinkState = Parameters<typeof findVisibleBrowserLinkTarget>[0]

const WT = 'folder:/project'
const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const split = (first: TabGroupLayoutNode, second: TabGroupLayoutNode): TabGroupLayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  first,
  second
})

/** left: browser a (focused at 10), right: browser b (focused at 20), bottom: terminal t (focused group). */
// Mutable groups so cases can swap one in place.
type MutableLinkState = Omit<VisibleBrowserLinkState, 'groupsByWorktree'> & {
  groupsByWorktree: Record<string, TabGroup[]>
}
function fixture(): MutableLinkState {
  const a = makeUnifiedTab({
    id: 'a',
    worktreeId: WT,
    groupId: 'left',
    contentType: 'browser',
    lastFocusedAt: 10
  })
  const b = makeUnifiedTab({
    id: 'b',
    worktreeId: WT,
    groupId: 'right',
    contentType: 'browser',
    lastFocusedAt: 20
  })
  const t = makeUnifiedTab({ id: 't', worktreeId: WT, groupId: 'bottom', contentType: 'terminal' })
  return {
    unifiedTabsByWorktree: { [WT]: [a, b, t] },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({ id: 'left', worktreeId: WT, activeTabId: 'a', tabOrder: ['a'] }),
        makeTabGroup({ id: 'right', worktreeId: WT, activeTabId: 'b', tabOrder: ['b'] }),
        makeTabGroup({ id: 'bottom', worktreeId: WT, activeTabId: 't', tabOrder: ['t'] })
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'bottom' },
    layoutByWorktree: { [WT]: split(split(leaf('left'), leaf('right')), leaf('bottom')) }
  }
}
const target = (state: VisibleBrowserLinkState, wt = WT) =>
  findVisibleBrowserLinkTarget(state, wt)?.targetGroupId

describe('findVisibleBrowserLinkTarget', () => {
  it('ignores a group that is not in the layout', () => {
    const s = fixture()
    s.layoutByWorktree = { [WT]: leaf('bottom') }
    expect(target(s)).toBeUndefined()
  })

  it("does not accept another group's tab as a group's active tab", () => {
    const s = fixture()
    s.groupsByWorktree![WT]![0] = makeTabGroup({
      id: 'left',
      worktreeId: WT,
      activeTabId: 'b',
      tabOrder: ['a']
    })
    s.groupsByWorktree![WT]![1] = makeTabGroup({
      id: 'right',
      worktreeId: WT,
      activeTabId: null,
      tabOrder: ['b']
    })
    expect(target(s)).toBeUndefined()
  })

  it('uses the renderer fallback (focused group, else first group) when no layout is recorded', () => {
    const s = fixture()
    s.layoutByWorktree = {}
    expect(target(s)).toBeUndefined() // focused group 'bottom' is the only one shown
    s.activeGroupIdByWorktree = { [WT]: 'left' }
    expect(target(s)).toBe('left')
    s.activeGroupIdByWorktree = {}
    expect(target(s)).toBe('left') // first group
  })
})
