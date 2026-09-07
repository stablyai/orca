// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { CrossProjectPaneLayout } from './cross-project-panes/CrossProjectPaneLayout'
import { TooltipProvider } from './ui/tooltip'
import {
  addPaneProject,
  resetPanePresentation
} from './cross-project-panes/pane-presentation-test-fixture'

vi.mock('./cross-project-panes/WorkspaceWatchingView', () => ({
  WorkspaceWatchingView: () => null
}))
vi.mock('./cross-project-panes/use-workspace-view-transfer', () => ({
  useWorkspaceViewTransfer: () => {}
}))
beforeEach(resetPanePresentation)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount() {
  addPaneProject('alpha', 'Project Alpha')
  addPaneProject('beta', 'Project Beta')
  render(
    <TooltipProvider>
      <CrossProjectPaneLayout />
    </TooltipProvider>
  )
}

async function openMenu() {
  const trigger = screen.getAllByRole('button', { name: 'Window actions' }).at(-1)!
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return screen.findByRole('menuitem', { name: 'Split Down' })
}

it('exposes layout actions through a keyboard-accessible menu even without a native bridge', async () => {
  mount()
  const tabCount = Object.values(useAppStore.getState().unifiedTabsByWorktree).flat().length
  await openMenu()
  for (const label of ['Split Right', 'Split Down', /Expand Pane|Restore Layout/]) {
    expect(screen.getByRole('menuitem', { name: label })).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('menuitem', { name: 'Split Down' }))
  expect(useAppStore.getState().windowPaneLayout!.root).toMatchObject({
    type: 'split',
    direction: 'vertical'
  })
  await openMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Close Pane' }))
  expect(screen.getAllByRole('region', { name: 'Workspace pane' })).toHaveLength(1)
  expect(Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()).toHaveLength(tabCount)
  expect(window.api.pty.kill).not.toHaveBeenCalled()
})

it('splits the selected pane without cloning its session', async () => {
  mount()
  const before = useAppStore.getState().windowPaneLayout!
  const selected = before.views[before.panes[before.activePaneId].selectedViewId!]
  await openMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Split Right' }))
  const after = useAppStore.getState().windowPaneLayout!
  expect(Object.keys(after.panes)).toHaveLength(2)
  expect(
    Object.values(after.views).filter((view) => view.entityId === selected.entityId)
  ).toHaveLength(1)
})

it('tab context menus split the clicked view through the presentation action', async () => {
  mount()
  const before = useAppStore.getState().windowPaneLayout!
  const first = before.panes[before.activePaneId].viewIds[0]
  fireEvent.contextMenu(screen.getAllByTestId('sortable-tab')[0], { clientX: 30, clientY: 20 })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Split Right' }))
  const layout = useAppStore.getState().windowPaneLayout!
  expect(layout.panes[layout.activePaneId].selectedViewId).toBe(first)
  expect(layout.root.type).toBe('split')
})

it('offers a named Move to Pane equivalent for a center drop', async () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Split Right' }))
  await openMenu()
  const item = screen.getByRole('menuitem', { name: 'Move to Pane' })
  fireEvent.keyDown(item, { key: 'ArrowRight' })
  fireEvent.click(await screen.findByRole('menuitem', { name: /Project Alpha.*alpha branch/ }))
  expect(
    Object.values(useAppStore.getState().windowPaneLayout!.panes).some(
      (pane) => pane.viewIds.length === 2
    )
  ).toBe(true)
})

it.each(['center', 'left', 'right', 'up', 'down'] as const)(
  'moves only the selected view at a %s destination',
  (zone) => {
    mount()
    const state = useAppStore.getState()
    const before = state.windowPaneLayout!
    const source = before.activePaneId
    const moved = before.panes[source].viewIds[0]
    state.splitWindowPane(source, 'horizontal')
    const destination = useAppStore.getState().windowPaneLayout!.activePaneId
    const tabs = useAppStore.getState().unifiedTabsByWorktree
    state.moveWorkspaceView(moved, { paneId: destination, zone })
    const after = useAppStore.getState().windowPaneLayout!
    const owner = Object.values(after.panes).find((pane) => pane.viewIds.includes(moved))!
    expect(after.panes[source].viewIds).not.toContain(moved)
    expect(owner.id === destination).toBe(zone === 'center')
    expect(after.views[moved]).toEqual(before.views[moved])
    expect(useAppStore.getState().unifiedTabsByWorktree).toBe(tabs)
    state.synchronizeWindowPaneSelection()
    expect(
      Object.values(useAppStore.getState().windowPaneLayout!.panes)
        .flatMap((pane) => pane.viewIds)
        .filter((id) => id === moved)
    ).toHaveLength(1)
  }
)

it('inserts before the named repeated view without altering the other instance', () => {
  mount()
  const state = useAppStore.getState()
  const before = state.windowPaneLayout!
  const paneId = before.activePaneId
  const [first, second] = before.panes[paneId].viewIds
  useAppStore.setState({
    windowPaneLayout: {
      ...before,
      views: { ...before.views, copy: { ...before.views[first], id: 'copy' } },
      panes: { [paneId]: { ...before.panes[paneId], viewIds: [first, second, 'copy'] } }
    }
  })
  state.moveWorkspaceView('copy', { paneId, zone: 'center', beforeViewId: second })
  expect(useAppStore.getState().windowPaneLayout!.panes[paneId].viewIds).toEqual([
    first,
    'copy',
    second
  ])
})

it.each([
  ['center', 250, 250],
  ['right', 490, 250],
  ['down', 250, 490]
] as const)(
  'previews and commits a real %s pointer drag without mutating during hover',
  async (zone, x, y) => {
    mount()
    const initial = useAppStore.getState().windowPaneLayout!
    const moved = initial.panes[initial.activePaneId].viewIds[0]
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute('data-tab-id')) {
          return new DOMRect(20, 0, 100, 32)
        }
        if (this.hasAttribute('data-tab-group-body-id')) {
          return new DOMRect(0, 60, 500, 440)
        }
        return new DOMRect(0, 0, 500, 500)
      }
    )
    const tab = screen.getAllByTestId('sortable-tab')[0]
    fireEvent.pointerDown(tab, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 50,
      clientY: 15
    })
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 70, clientY: 15 })
    fireEvent.pointerMove(document, { pointerId: 1, clientX: x, clientY: y })
    expect(
      await screen.findByText(
        zone === 'center' ? /Insert as tab in/ : new RegExp(`Split ${zone} of`)
      )
    ).toBeTruthy()
    const hovered = useAppStore.getState().windowPaneLayout!
    expect(hovered.root).toEqual(initial.root)
    expect(hovered.panes[initial.activePaneId].viewIds).toEqual(
      initial.panes[initial.activePaneId].viewIds
    )
    fireEvent.pointerUp(document, { pointerId: 1, clientX: x, clientY: y })
    await waitFor(() => {
      const layout = useAppStore.getState().windowPaneLayout!
      expect(layout.panes[layout.activePaneId].viewIds.at(-1)).toBe(moved)
      expect(layout.root.type).toBe(zone === 'center' ? 'leaf' : 'split')
    })
  }
)

it('creates a ready destination before moving to a new native window', async () => {
  let ready!: (id: number) => void
  const createWindow = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        ready = resolve
      })
  )
  const transfer = vi.fn(async () => true)
  Object.assign(window, {
    orcaWorkspaceViews: { ready: async () => 1, list: async () => [], createWindow, transfer }
  })
  mount()
  await openMenu()
  expect(screen.getByRole('menuitem', { name: 'New Window' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to New Window' }))
  expect(createWindow).toHaveBeenCalledTimes(1)
  expect(transfer).not.toHaveBeenCalled()
  ready(2)
  await waitFor(() =>
    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: 2, mode: 'tabs', viewIds: expect.any(Array) })
    )
  )
})
