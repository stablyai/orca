import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeTab, makeUnifiedTab, makeTabGroup } from './store-test-helpers'
import { measureWorkspaceViewLayout, type WorkspaceViewPanel } from '@/lib/workspace-view-layout'

const panel = (tabId: string): Omit<WorkspaceViewPanel, 'id'> => ({
  workspaceId: 'workspace',
  executionHostId: 'local',
  tabId,
  title: tabId,
  projectName: 'Project',
  workspaceName: 'main'
})

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('saved workspace views', () => {
  it('restores named selections, focus and custom divider ratios without changing workspace layouts', () => {
    const store = createTestStore()
    const layout = { type: 'leaf', groupId: 'group' } as const
    const tabs = [
      makeTab({ id: 'terminal-a', worktreeId: 'workspace' }),
      makeTab({ id: 'terminal-b', worktreeId: 'workspace' })
    ]
    store.setState({ layoutByWorktree: { workspace: layout }, tabsByWorktree: { workspace: tabs } })
    store.getState().createWorkspaceView('Daily work')
    const a = store.getState().addWorkspaceViewPanel(panel('terminal-a'))
    const b = store.getState().addWorkspaceViewPanel(panel('terminal-b'))
    expect(a).not.toBe(b)
    store.getState().setWorkspaceViewPreset('primary')
    store.getState().setWorkspaceViewRatio([], 0.68)
    const restored = createTestStore().getState()
    expect(restored.workspaceViews[0]).toMatchObject({
      name: 'Daily work',
      preset: 'primary',
      focusedPanelId: b,
      layout: { ratio: 0.68 }
    })
    expect(restored.workspaceViews[0].panels.map((p) => p.tabId)).toEqual([
      'terminal-a',
      'terminal-b'
    ])
    expect(store.getState().layoutByWorktree.workspace).toBe(layout)
    expect(store.getState().tabsByWorktree.workspace).toBe(tabs)
  })

  it('removing a panel or saved view leaves real terminal tabs and groups intact', () => {
    const store = createTestStore()
    const tabs = [makeTab({ id: 'terminal-a', worktreeId: 'workspace' })]
    const unified = [
      makeUnifiedTab({ id: 'terminal-a', worktreeId: 'workspace', groupId: 'group' })
    ]
    const groups = [
      makeTabGroup({ id: 'group', worktreeId: 'workspace', tabOrder: ['terminal-a'] })
    ]
    store.setState({
      tabsByWorktree: { workspace: tabs },
      unifiedTabsByWorktree: { workspace: unified },
      groupsByWorktree: { workspace: groups }
    })
    const viewId = store.getState().createWorkspaceView('Watch')
    const id = store.getState().addWorkspaceViewPanel(panel('terminal-a'))
    if (!id || !viewId) {
      throw new Error('View creation failed')
    }
    store.getState().removeWorkspaceViewPanel(id)
    store.getState().removeWorkspaceView(viewId)
    expect(store.getState().tabsByWorktree.workspace).toBe(tabs)
    expect(store.getState().unifiedTabsByWorktree.workspace).toBe(unified)
    expect(store.getState().groupsByWorktree.workspace).toBe(groups)
    expect(store.getState().workspaceViews).toEqual([])
  })

  it('deduplicates the exact host/workspace/tab but accepts two different tabs in one workspace', () => {
    const store = createTestStore()
    store.getState().createWorkspaceView('Watch')
    const first = store.getState().addWorkspaceViewPanel(panel('a'))
    expect(store.getState().addWorkspaceViewPanel(panel('a'))).toBe(first)
    store.getState().addWorkspaceViewPanel(panel('b'))
    store.getState().addWorkspaceViewPanel({ ...panel('a'), executionHostId: 'ssh:build' })
    expect(store.getState().workspaceViews[0].panels).toHaveLength(3)
  })

  it('replaces one target without changing its cell or destroying the old tab', () => {
    const store = createTestStore()
    store.getState().createWorkspaceView('Watch')
    const first = store.getState().addWorkspaceViewPanel(panel('a'))
    store.getState().addWorkspaceViewPanel(panel('b'))
    store.getState().setWorkspaceViewRatio([], 0.7)
    const layout = store.getState().workspaceViews[0].layout
    if (!first) {
      throw new Error('Missing first panel')
    }
    store.getState().addWorkspaceViewPanel(panel('c'), first)
    expect(store.getState().workspaceViews[0].layout).toBe(layout)
    expect(store.getState().workspaceViews[0].panels[0]).toMatchObject({ id: first, tabId: 'c' })
  })

  it('collapses a removed cell and keeps the remaining panels filling the view', () => {
    const store = createTestStore()
    store.getState().createWorkspaceView('Watch')
    for (const id of ['a', 'b', 'c', 'd']) {
      store.getState().addWorkspaceViewPanel(panel(id))
    }
    const removed = store.getState().workspaceViews[0].panels[0].id
    store.getState().removeWorkspaceViewPanel(removed)
    const rects = [
      ...measureWorkspaceViewLayout(store.getState().workspaceViews[0].layout).panels.values()
    ]
    expect(rects).toHaveLength(3)
    expect(rects.reduce((area, rect) => area + rect.width * rect.height, 0)).toBeCloseTo(10000)
    expect(
      measureWorkspaceViewLayout(store.getState().workspaceViews[0].layout).panels.has(removed)
    ).toBe(false)
  })

  it('bounds view size and keeps independent named arrangements', () => {
    const store = createTestStore()
    const first = store.getState().createWorkspaceView('First')
    for (let index = 0; index < 9; index++) {
      store.getState().addWorkspaceViewPanel(panel(String(index)))
    }
    store.getState().createWorkspaceView('Second')
    store.getState().addWorkspaceViewPanel(panel('other'))
    store.getState().selectWorkspaceView(first)
    expect(store.getState().workspaceViews.map((view) => view.panels.length)).toEqual([6, 1])
    expect(store.getState().activeWorkspaceViewId).toBe(first)
  })

  it('fill-window and temporary expansion never change saved sidebar preferences', () => {
    const store = createTestStore()
    store.setState({ sidebarOpen: true, rightSidebarOpen: false })
    store.getState().createWorkspaceView('Watch')
    const id = store.getState().addWorkspaceViewPanel(panel('a'))
    if (!id) {
      throw new Error('Missing panel')
    }
    store.getState().toggleWorkspaceViewPanelExpand(id)
    store.getState().toggleWorkspaceViewFillWindow()
    store.getState().selectWorkspaceView(null)
    expect(store.getState()).toMatchObject({
      sidebarOpen: true,
      rightSidebarOpen: false,
      workspaceViewFillWindow: false,
      workspaceViewExpandedPanelId: null
    })
  })
})
