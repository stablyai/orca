// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { WorkspaceViewBridge } from '../../../shared/workspace-view-bridge'
import { useWorkspaceViewTransfer } from './cross-project-panes/use-workspace-view-transfer'
import {
  addPaneProject,
  resetPanePresentation
} from './cross-project-panes/pane-presentation-test-fixture'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { useWorktreeJumpPalettePlacements } from './use-worktree-jump-palette-placements'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: vi.fn(async () => ({ runtimeId: 'owner' }))
}))
let request: Parameters<WorkspaceViewBridge['onRequest']>[0]
beforeEach(() => {
  resetPanePresentation()
  useAppStore.setState({ workspaceSessionReady: true })
  Object.assign(window, {
    orcaWorkspaceViews: {
      ready: vi.fn(async () => 1),
      registerViews: vi.fn(async () => {}),
      onRequest: (callback: typeof request) => {
        request = callback
        return () => {}
      }
    }
  })
  Object.assign(window.api, {
    session: { patch: vi.fn(async () => {}), flush: vi.fn(async () => {}) }
  })
})
afterEach(cleanup)

it('applies the existing project and host filter to runtime-aliased placements', async () => {
  addPaneProject('alpha', 'Alpha')
  const view = Object.values(useAppStore.getState().windowPaneLayout!.views)[0]
  const placement = {
    windowId: 2,
    epoch: 1,
    windowTitle: 'Other',
    paneId: 'other',
    paneNumber: 1,
    view: { ...view, executionHostId: 'runtime:other-alias' as const },
    owner: 'owner',
    session: view.entityId,
    projectName: 'Alpha',
    workspace: 'Alpha',
    hostName: 'This computer',
    availability: ''
  }
  Object.assign(window.orcaWorkspaceViews!, { discover: vi.fn(async () => [placement]) })
  const matchesWorktree = vi.fn(() => false)
  const filter = {
    matchesWorktree,
    matchesProjectRowKey: () => false,
    matchesGroupHostId: () => false
  }
  const { result, rerender } = renderHook(
    ({ predicate }) => useWorktreeJumpPalettePlacements(true, '', predicate),
    { initialProps: { predicate: filter } }
  )
  await waitFor(() =>
    expect(matchesWorktree).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'local' }))
  )
  expect(result.current.placements).toEqual([])
  rerender({ predicate: { ...filter, matchesWorktree: vi.fn(() => true) } })
  await waitFor(() => expect(result.current.placements).toHaveLength(1))
  expect(result.current.placements[0].localView?.tabId).toBe(view.tabId)
})

it('renders searchable native placements and routes Enter, Open Here and Open Beside', async () => {
  addPaneProject('alpha', 'Alpha')
  const layout = useAppStore.getState().windowPaneLayout!
  const placement = {
    windowId: 2,
    epoch: 3,
    windowTitle: 'Second window',
    paneId: 'other',
    paneNumber: 2,
    view: { ...Object.values(layout.views)[0], id: 'remote-view', label: 'Unique draft' },
    projectName: 'Beta',
    workspace: 'folder',
    hostName: 'This computer',
    availability: ''
  }
  const visit = vi.fn(async () => true)
  const open = vi.fn(async () => true)
  Object.assign(window.orcaWorkspaceViews!, {
    discover: vi.fn(async () => [placement]),
    visit,
    open
  })
  useAppStore.setState({ activeModal: 'worktree-palette' })
  render(<WorktreeJumpPalette />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Unique' } })
  const row = await screen.findByRole('option', { name: /Unique draft.*Second window/ })
  expect(row.textContent).toContain('Pane 2')
  fireEvent.click(within(row).getByRole('button', { name: 'Open Here' }))
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      { windowId: 2, epoch: 3, paneId: 'other', viewId: 'remote-view' },
      { paneId: layout.activePaneId, zone: 'center' }
    )
  )
  await waitFor(() => expect(useAppStore.getState().activeModal).toBe('none'))
  act(() => useAppStore.setState({ activeModal: 'worktree-palette' }))
  fireEvent.click(
    within(await screen.findByRole('option', { name: /Unique draft.*Second window/ })).getByRole(
      'button',
      { name: 'Open Beside' }
    )
  )
  await waitFor(() =>
    expect(open).toHaveBeenLastCalledWith(expect.anything(), {
      paneId: layout.activePaneId,
      zone: 'right'
    })
  )
  await waitFor(() => expect(useAppStore.getState().activeModal).toBe('none'))
  act(() => useAppStore.setState({ activeModal: 'worktree-palette' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Unique' } })
  await waitFor(() =>
    expect(
      screen
        .getByRole('option', { name: /Unique draft.*Second window/ })
        .getAttribute('aria-selected')
    ).toBe('true')
  )
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await waitFor(() =>
    expect(visit).toHaveBeenCalledWith({
      windowId: 2,
      epoch: 3,
      paneId: 'other',
      viewId: 'remote-view'
    })
  )
})

it('discovers repeated views and editors across projects without using control registrations', async () => {
  addPaneProject('alpha', 'Alpha')
  addPaneProject('beta', 'Beta')
  const state = useAppStore.getState()
  state.createUnifiedTab('beta-workspace', 'editor', {
    executionHostId: 'local',
    label: 'draft.md',
    entityId: 'draft'
  })
  state.synchronizeWindowPaneSelection()
  state.openAnotherWorkspaceView(state.windowPaneLayout!.activePaneId)
  renderHook(useWorkspaceViewTransfer)
  const entries = (await request('discover', {})) as {
    view: { contentType: string }
    paneId: string
    projectName: string
  }[]
  expect(entries).toHaveLength(4)
  expect(entries.some((entry) => entry.view.contentType === 'editor')).toBe(true)
  expect(new Set(entries.map((entry) => entry.projectName))).toEqual(new Set(['Alpha', 'Beta']))
  expect(new Set(entries.map((entry) => entry.paneId)).size).toBe(2)
})

it('visits an exact repeated view and rejects stale pane membership', async () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  const original = state.windowPaneLayout!
  state.openAnotherWorkspaceView(original.activePaneId)
  state.expandWindowPane(useAppStore.getState().windowPaneLayout!.activePaneId)
  useAppStore.setState({ activeView: 'settings' })
  renderHook(useWorkspaceViewTransfer)
  const target = {
    paneId: original.activePaneId,
    viewId: original.panes[original.activePaneId].selectedViewId
  }
  await act(async () => {
    expect(await request('visit', target)).toBe(true)
  })
  expect(useAppStore.getState().windowPaneLayout!.activePaneId).toBe(target.paneId)
  expect(useAppStore.getState().windowPaneLayout!.expandedPaneId).toBeNull()
  expect(useAppStore.getState().activeView).toBe('terminal')
  await expect(request('visit', { ...target, viewId: 'closed' })).resolves.toBe(false)
})

it('routes a legacy tab result to its existing pane without changing the invoking layout', async () => {
  addPaneProject('alpha', 'Alpha')
  const layout = useAppStore.getState().windowPaneLayout!
  const view = Object.values(layout.views)[0]
  const label = 'Alpha terminal'
  useAppStore.setState((state) => ({
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [view.worktreeId]: state.unifiedTabsByWorktree[view.worktreeId].map((tab) => ({
        ...tab,
        customLabel: label
      }))
    }
  }))
  const visit = vi.fn(async () => true)
  Object.assign(window.orcaWorkspaceViews!, {
    visit,
    discover: vi.fn(async () => [
      {
        windowId: 2,
        epoch: 1,
        windowTitle: 'Other',
        paneId: 'other',
        paneNumber: 1,
        view: { ...view, label, executionHostId: 'runtime:other-alias' },
        owner: 'owner',
        session: view.entityId,
        projectName: 'Alpha',
        workspace: 'Alpha',
        hostName: 'This computer',
        availability: ''
      }
    ])
  })
  useAppStore.setState({ activeModal: 'worktree-palette' })
  render(<WorktreeJumpPalette />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: label } })
  await screen.findByRole('option', { name: /Alpha terminal.*Other/ })
  const legacy = screen
    .getAllByRole('option')
    .find((row) => row.textContent?.includes(label) && !row.textContent.includes('Other'))
  expect(legacy).toBeTruthy()
  fireEvent.click(legacy!)
  await waitFor(() =>
    expect(visit).toHaveBeenCalledWith({ windowId: 2, epoch: 1, paneId: 'other', viewId: view.id })
  )
  expect(useAppStore.getState().windowPaneLayout).toEqual(layout)
})

it('Open Here and Beside import presentation without hijacking or changing session inventory', async () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  const original = state.windowPaneLayout!
  const viewId = original.panes[original.activePaneId].selectedViewId!
  renderHook(useWorkspaceViewTransfer)
  const packet = await request('capture', { id: 'open', viewIds: [viewId] })
  state.closeWorkspaceView(original.activePaneId, viewId)
  const sessions = useAppStore.getState().unifiedTabsByWorktree
  await act(async () => {
    await request('import', {
      id: 'here',
      packet,
      mode: 'tabs',
      target: { paneId: original.activePaneId, zone: 'center' }
    })
  })
  const here = useAppStore.getState().windowPaneLayout!
  expect(here.panes[original.activePaneId].dismissedTabKeys).toEqual([])
  await act(async () => {
    await request('import', {
      id: 'beside',
      packet,
      mode: 'tabs',
      target: { paneId: original.activePaneId, zone: 'right' }
    })
  })
  expect(useAppStore.getState().windowPaneLayout!.panes[original.activePaneId]).toEqual(
    here.panes[original.activePaneId]
  )
  expect(Object.keys(useAppStore.getState().windowPaneLayout!.views)).toHaveLength(2)
  expect(useAppStore.getState().unifiedTabsByWorktree).toBe(sessions)
})
