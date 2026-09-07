// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { useWindowPaneNavigation } from './cross-project-panes/use-window-pane-navigation'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../store'
import { TooltipProvider } from './ui/tooltip'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { isWorkspaceViewController } from './cross-project-panes/workspace-view-control-state'

const initialState = useAppStore.getState()

beforeEach(() => {
  const domWindow = window
  const api = createTabsSliceMockApi()
  globalThis.window = domWindow
  Object.assign(window, { api })
  useAppStore.setState(initialState, true)
  useAppStore.setState({ persistedUIReady: true, hydrationSucceeded: true, activeView: 'terminal' })
})
afterEach(cleanup)

async function mountPanes() {
  renderHook(useWindowPaneNavigation)
  expect(useAppStore.getState()).toHaveProperty('initializeWindowPanes')
  const { CrossProjectPaneLayout } = await import('./cross-project-panes/CrossProjectPaneLayout')
  return render(
    <TooltipProvider>
      <CrossProjectPaneLayout />
    </TooltipProvider>
  )
}

function seed() {
  const state = useAppStore.getState()
  const alpha = state.createUnifiedTab('alpha', 'terminal', {
    label: 'Alpha shell',
    executionHostId: 'local'
  })
  const alphaTwo = state.createUnifiedTab('alpha', 'terminal', {
    label: 'Alpha second',
    executionHostId: 'local'
  })
  const beta = state.createUnifiedTab('beta', 'terminal', {
    label: 'Beta shell',
    executionHostId: 'local'
  })
  useAppStore.setState({
    activeWorktreeId: 'alpha',
    activeTabId: alpha.entityId,
    activeTabType: 'terminal'
  })
  state.activateTab(alpha.id)
  return { alpha, alphaTwo, beta }
}

describe('cross-project pane navigation', () => {
  it('targets an empty folder workspace without keeping the previous project selection', async () => {
    seed()
    await mountPanes()
    act(() =>
      useAppStore.setState({
        activeWorktreeId: 'empty-folder',
        activeWorkspaceExecutionHostId: 'local'
      })
    )
    const state = useAppStore.getState()
    const pane = state.windowPaneLayout!.panes[state.windowPaneLayout!.activePaneId]
    expect(state.activeWorktreeId).toBe('empty-folder')
    expect(state.activeTabId).toBeNull()
    expect(pane.selectedViewId).toBeNull()
    expect(pane.workspace?.worktreeId).toBe('empty-folder')
  })
  it('selects an already visible session in its existing pane', async () => {
    const { alphaTwo } = seed()
    await mountPanes()
    fireEvent.click(screen.getByRole('button', { name: 'Split Right' }))
    act(() => {
      const state = useAppStore.getState()
      useAppStore.setState({
        activeTabId: alphaTwo.entityId,
        groupsByWorktree: {
          ...state.groupsByWorktree,
          alpha: state.groupsByWorktree.alpha.map((group) => ({
            ...group,
            activeTabId: alphaTwo.id
          }))
        }
      })
    })
    const state = useAppStore.getState()
    const layout = state.windowPaneLayout!
    expect(layout.views[layout.panes[layout.activePaneId].selectedViewId!].entityId).toBe(
      alphaTwo.entityId
    )
    expect(state.activeTabId).toBe(alphaTwo.entityId)
    expect(state.getActiveTab('alpha')?.id).toBe(alphaTwo.id)
    expect(screen.queryByText('Watching')).toBeNull()
  })
  it('honors activateTab when its catalog update selects a session in another pane', async () => {
    const { alphaTwo } = seed()
    await mountPanes()
    fireEvent.click(screen.getByRole('button', { name: 'Split Right' }))
    act(() => useAppStore.getState().activateTab(alphaTwo.id))
    const state = useAppStore.getState()
    const layout = state.windowPaneLayout!
    expect(layout.views[layout.panes[layout.activePaneId].selectedViewId!].tabId).toBe(alphaTwo.id)
    expect(state.getActiveTab('alpha')?.id).toBe(alphaTwo.id)
    expect(screen.queryByText('Watching')).toBeNull()
  })
  it('keeps the expanded pane when selecting another view of an existing session', async () => {
    const { alphaTwo } = seed()
    await mountPanes()
    fireEvent.click(screen.getByRole('button', { name: 'Split Right' }))
    act(() => useAppStore.getState().synchronizeWindowPaneSelection())
    const layout = useAppStore.getState().windowPaneLayout!
    const pane = layout.panes[layout.activePaneId]
    act(() => useAppStore.getState().expandWindowPane(pane.id))
    act(() => useAppStore.getState().activateTab(alphaTwo.id))
    expect(screen.getAllByRole('region', { name: 'Workspace pane' })).toHaveLength(1)
    expect(useAppStore.getState().windowPaneLayout?.expandedPaneId).toBe(
      useAppStore.getState().windowPaneLayout?.activePaneId
    )
    expect(screen.queryByText('Watching')).toBeNull()
    expect(useAppStore.getState().activeTabId).toBe(alphaTwo.entityId)
  })
  it('projects the active pane selection when sidebar navigation requests a session already shown elsewhere', async () => {
    const { alphaTwo, beta } = seed()
    await mountPanes()
    fireEvent.click(screen.getByRole('button', { name: 'Split Right' }))
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'beta' })
      useAppStore.getState().activateTab(beta.id)
    })
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'alpha' })
      useAppStore.getState().activateTab(alphaTwo.id)
    })
    const state = useAppStore.getState()
    const layout = state.windowPaneLayout!
    const selected = layout.views[layout.panes[layout.activePaneId].selectedViewId!]
    expect(state.activeTabId).toBe(selected.entityId)
  })
  it('keeps one controller when closing a mixed strip reveals a repeated session', async () => {
    const { beta } = seed()
    await mountPanes()
    fireEvent.click(screen.getByRole('button', { name: 'Split Right' }))
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'beta' })
      useAppStore.getState().activateTab(beta.id)
    })
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'alpha' })
    })
    const state = useAppStore.getState()
    const layout = state.windowPaneLayout!
    const pane = layout.panes[layout.activePaneId]
    act(() => state.closeWorkspaceView(pane.id, pane.selectedViewId!))
    const after = useAppStore.getState().windowPaneLayout!
    const selected = Object.values(after.panes).flatMap((p) =>
      p.selectedViewId ? [after.views[p.selectedViewId]] : []
    )
    expect(new Set(selected.map((view) => view.id)).size).toBe(selected.length)
    for (const entityId of new Set(selected.map((view) => view.entityId))) {
      expect(
        selected.filter((view) => view.entityId === entityId && isWorkspaceViewController(view))
      ).toHaveLength(1)
    }
    const active = after.panes[after.activePaneId]
    expect(useAppStore.getState().activeTabId).toBe(
      active.selectedViewId ? after.views[active.selectedViewId].entityId : null
    )
  })
  it('keeps resolved sibling tabs reachable when the selected session is unavailable', async () => {
    const { alphaTwo } = seed()
    await mountPanes()
    act(() => useAppStore.setState({ unifiedTabsByWorktree: { alpha: [alphaTwo] } }))
    fireEvent.pointerDown(screen.getByText('Alpha second'), { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 })
    expect(useAppStore.getState().activeTabId).toBe(alphaTwo.entityId)
    expect(screen.queryByText('Session unavailable')).toBeNull()
  })
  it('shows an unavailable selected view without choosing another project for it', async () => {
    const { alpha } = seed()
    await mountPanes()
    act(() => useAppStore.setState({ unifiedTabsByWorktree: {} }))
    expect(screen.getByText('Session unavailable')).toBeTruthy()
    expect(screen.getByText('Alpha shell')).toBeTruthy()
    expect(
      Object.values(useAppStore.getState().windowPaneLayout!.views).some(
        (view) => view.tabId === alpha.id
      )
    ).toBe(true)
  })
  it('keeps a closed view detached when another tab is selected', async () => {
    const { alpha, alphaTwo } = seed()
    await mountPanes()
    const state = useAppStore.getState()
    const layout = state.windowPaneLayout!
    const view = Object.values(layout.views).find((view) => view.tabId === alpha.id)!
    act(() => state.closeWorkspaceView(layout.activePaneId, view.id))
    act(() => state.activateTab(alphaTwo.id))
    expect(screen.queryByText('Alpha shell')).toBeNull()
    expect(state.getTab(alpha.id)).toBeTruthy()
  })
  it('opens a previously visited project in the active pane without removing the other pane tabs', async () => {
    const { alpha, beta } = seed()
    await mountPanes()
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'beta' })
      useAppStore.getState().activateTab(beta.id)
    })
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'alpha' })
      useAppStore.getState().activateTab(alpha.id)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Split Right' }))
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'beta' })
      useAppStore.getState().activateTab(beta.id)
    })
    const panes = screen.getAllByRole('region', { name: 'Workspace pane' })
    expect(within(panes[0]).getByText('Beta shell')).toBeTruthy()
    expect(within(panes[1]).queryByText('Beta shell')).toBeNull()
  })
  it('renders different projects side by side and routes navigation only to the active pane', async () => {
    const { alpha, beta } = seed()
    await mountPanes()
    const first = screen.getByRole('region', { name: 'Workspace pane' })
    fireEvent.click(within(first).getByRole('button', { name: 'Split Right' }))
    const panes = screen.getAllByRole('region', { name: 'Workspace pane' })
    expect(panes).toHaveLength(2)
    act(() => {
      useAppStore.setState({ activeWorktreeId: 'beta', activeTabId: beta.entityId })
      useAppStore.getState().activateTab(beta.id)
    })
    expect(within(panes[0]).queryByText('Beta shell')).toBeNull()
    expect(within(panes[1]).getByText('Beta shell')).toBeTruthy()
    expect(within(panes[0]).getByText('Alpha second')).toBeTruthy()
    const layout = useAppStore.getState().windowPaneLayout!
    expect(layout.views[layout.panes[layout.activePaneId].selectedViewId!].entityId).toBe(
      beta.entityId
    )
    expect(useAppStore.getState().getTab(alpha.id)?.worktreeId).toBe('alpha')
  })

  it('keeps two selections of the same project independent when focus changes', async () => {
    const { alpha, alphaTwo } = seed()
    await mountPanes()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Window actions' }), { button: 0 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split Down' }))
    const panes = screen.getAllByRole('region', { name: 'Workspace pane' })
    fireEvent.pointerDown(panes[0])
    expect(useAppStore.getState().activeTabId).toBe(alphaTwo.entityId)
    fireEvent.pointerDown(panes[1])
    expect(useAppStore.getState().activeTabId).toBe(alpha.entityId)
    const layout = useAppStore.getState().windowPaneLayout!
    const selected = Object.values(layout.panes).map(
      (pane) => layout.views[pane.selectedViewId!].entityId
    )
    expect(selected).toEqual([alphaTwo.entityId, alpha.entityId])
  })
})
