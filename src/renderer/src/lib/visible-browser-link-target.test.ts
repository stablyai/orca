import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { makeTabGroup, makeUnifiedTab } from '../store/slices/store-test-helpers'
import {
  findVisibleBrowserLinkTarget,
  type VisibleBrowserLinkState
} from './visible-browser-link-target'

const WT = 'folder:/project'
const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const split = (first: TabGroupLayoutNode, second: TabGroupLayoutNode): TabGroupLayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  first,
  second
})

/** left: browser a (focused at 10), right: browser b (focused at 20), bottom: terminal t (focused group). */
function fixture(): VisibleBrowserLinkState {
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
  it('returns the group and the fixed-placement flag', () => {
    expect(findVisibleBrowserLinkTarget(fixture(), WT)).toEqual({
      targetGroupId: 'right',
      placementFixed: true
    })
  })

  it('prefers the focused group when it shows a browser', () => {
    const s = fixture()
    s.activeGroupIdByWorktree = { [WT]: 'left' }
    expect(target(s)).toBe('left')
  })

  // Unlike resolveEditorOpenTargetGroupId (terminal-only trigger): markdown links come from editor panes.
  it('redirects from a focused editor pane too', () => {
    const s = fixture()
    s.unifiedTabsByWorktree![WT] = s.unifiedTabsByWorktree![WT]!.map((t) =>
      t.id === 't' ? { ...t, contentType: 'editor' } : t
    )
    expect(target(s)).toBe('right')
  })

  it.each([
    ['left', 'right'],
    ['right', 'left']
  ])('finds the browser in both mirror orders (%s | %s)', (termSide, webSide) => {
    const s: VisibleBrowserLinkState = {
      unifiedTabsByWorktree: {
        [WT]: [
          makeUnifiedTab({ id: 't', worktreeId: WT, groupId: termSide, contentType: 'terminal' }),
          makeUnifiedTab({ id: 'w', worktreeId: WT, groupId: webSide, contentType: 'browser' })
        ]
      },
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({ id: termSide, worktreeId: WT, activeTabId: 't', tabOrder: ['t'] }),
          makeTabGroup({ id: webSide, worktreeId: WT, activeTabId: 'w', tabOrder: ['w'] })
        ]
      },
      activeGroupIdByWorktree: { [WT]: termSide },
      layoutByWorktree: { [WT]: split(leaf('left'), leaf('right')) }
    }
    expect(target(s)).toBe(webSide)
  })

  it('ignores a browser hidden behind another tab in its group', () => {
    const s = fixture()
    s.groupsByWorktree![WT]![1] = makeTabGroup({
      id: 'right',
      worktreeId: WT,
      activeTabId: null,
      tabOrder: ['b']
    })
    expect(target(s)).toBe('left')
  })

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

  it('breaks recency ties by layout order', () => {
    const s = fixture()
    s.unifiedTabsByWorktree![WT] = s.unifiedTabsByWorktree![WT]!.map((t) => ({
      ...t,
      lastFocusedAt: undefined
    }))
    expect(target(s)).toBe('left')
  })

  it('never borrows another worktree and survives an empty state', () => {
    expect(target(fixture(), 'other')).toBeUndefined()
    expect(findVisibleBrowserLinkTarget({}, WT)).toBeUndefined()
  })
})
