import { describe, expect, it } from 'vitest'
import { collectLeafWorktreeIds } from './worktree-layout-tree'
import {
  activateWorkbenchView,
  closeActivePane,
  closeWorkbenchView,
  createSingleLeafView,
  EMPTY_WORKBENCH_VIEW_STATE,
  focusActivePane,
  getActiveWorkbenchView,
  getVisibleWorktreeIds,
  moveWorkbenchView,
  renameWorkbenchView,
  retargetFocusedPane,
  setActivePaneRatio,
  shouldShowProjectTabStrip,
  singleLeafViewState,
  splitActivePane,
  type WorkbenchViewState
} from './workbench-view-model'

// A view v1 holding a horizontal A|B split, focused on B.
const splitState = (): WorkbenchViewState =>
  splitActivePane(singleLeafViewState('v1', 'A'), 'A', 'horizontal', 'B')

describe('singleLeafViewState / selectors', () => {
  it('builds one focused single-leaf view', () => {
    const state = singleLeafViewState('v1', 'A')
    expect(getActiveWorkbenchView(state)).toEqual({
      id: 'v1',
      layout: { type: 'leaf', worktreeId: 'A' },
      focusedWorktreeId: 'A'
    })
    expect(getVisibleWorktreeIds(state)).toEqual(['A'])
  })

  it('returns null active view / empty visible set for empty state', () => {
    expect(getActiveWorkbenchView(EMPTY_WORKBENCH_VIEW_STATE)).toBeNull()
    expect(getVisibleWorktreeIds(EMPTY_WORKBENCH_VIEW_STATE)).toEqual([])
  })
})

describe('shouldShowProjectTabStrip (no always-on second tab layer)', () => {
  it('is hidden for a lone single-leaf view', () => {
    expect(shouldShowProjectTabStrip(singleLeafViewState('v1', 'A'))).toBe(false)
  })

  it('shows when a second view exists', () => {
    const two = createSingleLeafView(singleLeafViewState('v1', 'A'), 'v2', 'B')
    expect(shouldShowProjectTabStrip(two)).toBe(true)
  })

  it('shows when the active view is multi-pane', () => {
    expect(shouldShowProjectTabStrip(splitState())).toBe(true)
  })

  it('shows when pinned, even for a lone single-leaf view', () => {
    expect(shouldShowProjectTabStrip(singleLeafViewState('v1', 'A'), { pinned: true })).toBe(true)
  })
})

describe('view-list operations', () => {
  it('creates and activates a new view by default', () => {
    const state = createSingleLeafView(singleLeafViewState('v1', 'A'), 'v2', 'B')
    expect(state.activeWorkbenchViewId).toBe('v2')
    expect(state.workbenchViews.map((v) => v.id)).toEqual(['v1', 'v2'])
  })

  it('can create without activating', () => {
    const state = createSingleLeafView(singleLeafViewState('v1', 'A'), 'v2', 'B', {
      activate: false
    })
    expect(state.activeWorkbenchViewId).toBe('v1')
  })

  it('activates an existing view and no-ops otherwise', () => {
    const two = createSingleLeafView(singleLeafViewState('v1', 'A'), 'v2', 'B')
    expect(activateWorkbenchView(two, 'v1').activeWorkbenchViewId).toBe('v1')
    expect(activateWorkbenchView(two, 'missing')).toBe(two)
  })

  it('closes the active view and activates the right neighbor', () => {
    let state = singleLeafViewState('v1', 'A')
    state = createSingleLeafView(state, 'v2', 'B')
    state = createSingleLeafView(state, 'v3', 'C')
    state = activateWorkbenchView(state, 'v2')
    const closed = closeWorkbenchView(state, 'v2')
    expect(closed.workbenchViews.map((v) => v.id)).toEqual(['v1', 'v3'])
    expect(closed.activeWorkbenchViewId).toBe('v3') // right neighbor
  })

  it('closing the last view clears the active id', () => {
    const closed = closeWorkbenchView(singleLeafViewState('v1', 'A'), 'v1')
    expect(closed.workbenchViews).toEqual([])
    expect(closed.activeWorkbenchViewId).toBeNull()
  })

  it('renames and clears titles', () => {
    const named = renameWorkbenchView(singleLeafViewState('v1', 'A'), 'v1', '  Backend  ')
    expect(named.workbenchViews[0].title).toBe('Backend')
    const cleared = renameWorkbenchView(named, 'v1', '   ')
    expect(cleared.workbenchViews[0].title).toBeUndefined()
  })

  it('reorders views with clamping', () => {
    let state = singleLeafViewState('v1', 'A')
    state = createSingleLeafView(state, 'v2', 'B')
    state = createSingleLeafView(state, 'v3', 'C')
    expect(moveWorkbenchView(state, 'v1', 5).workbenchViews.map((v) => v.id)).toEqual([
      'v2',
      'v3',
      'v1'
    ])
    expect(moveWorkbenchView(state, 'v3', 0).workbenchViews.map((v) => v.id)).toEqual([
      'v3',
      'v1',
      'v2'
    ])
  })
})

describe('active-pane operations', () => {
  it('splits the active pane and focuses the new worktree', () => {
    const state = splitState()
    const view = getActiveWorkbenchView(state)!
    expect(collectLeafWorktreeIds(view.layout)).toEqual(['A', 'B'])
    expect(view.focusedWorktreeId).toBe('B')
  })

  it('is a no-op when splitting in a worktree already visible', () => {
    const state = splitState()
    expect(splitActivePane(state, 'A', 'vertical', 'B')).toBe(state)
  })

  it('closes a pane, collapses the split, and keeps focus valid', () => {
    const state = splitState() // A|B focused B
    const closed = closeActivePane(state, 'B')
    const view = getActiveWorkbenchView(closed)!
    expect(view.layout).toEqual({ type: 'leaf', worktreeId: 'A' })
    expect(view.focusedWorktreeId).toBe('A') // focus moved off the removed pane
  })

  it('closing the last pane of a view closes the view', () => {
    const state = singleLeafViewState('v1', 'A')
    const closed = closeActivePane(state, 'A')
    expect(closed.workbenchViews).toEqual([])
    expect(closed.activeWorkbenchViewId).toBeNull()
  })

  it('retargets the focused pane when the target is not visible', () => {
    const state = splitState() // A|B focused B
    const retargeted = retargetFocusedPane(state, 'C')
    const view = getActiveWorkbenchView(retargeted)!
    expect(collectLeafWorktreeIds(view.layout)).toEqual(['A', 'C'])
    expect(view.focusedWorktreeId).toBe('C')
  })

  it('retargetFocusedPane just focuses a worktree that is already visible', () => {
    const state = splitState() // A|B focused B
    const focused = retargetFocusedPane(state, 'A')
    const view = getActiveWorkbenchView(focused)!
    expect(collectLeafWorktreeIds(view.layout)).toEqual(['A', 'B']) // unchanged layout
    expect(view.focusedWorktreeId).toBe('A')
  })

  it('sets a pane ratio (clamped) on the active view', () => {
    const state = splitState()
    const ratioed = setActivePaneRatio(state, [], 0.95)
    const layout = getActiveWorkbenchView(ratioed)!.layout
    expect(layout.type === 'split' && layout.ratio).toBe(0.85)
  })

  it('focuses a visible pane and no-ops on a hidden one', () => {
    const state = splitState() // focused B
    expect(getActiveWorkbenchView(focusActivePane(state, 'A'))!.focusedWorktreeId).toBe('A')
    expect(focusActivePane(state, 'Z')).toBe(state)
  })
})
