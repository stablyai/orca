// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TabCluster, TabGroup } from '../../../../shared/tab-types'
import { TabClusterChip } from './TabClusterChip'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  seedStore,
  type TestStore
} from '@/store/slices/store-test-helpers'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import { createFloatingTerminalPanelDragActions } from '../floating-terminal/floating-terminal-panel-drag-actions'

let store: TestStore

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => store(selector), {
    getState: () => store.getState()
  })
}))
vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: { role: 'button', tabIndex: 0 },
    listeners: undefined,
    setNodeRef: () => {}
  })
}))
vi.mock('../tab-group/useTabDragSplit', () => ({ TAB_DRAG_ACTIVATION_DISTANCE_PX: 5 }))

const CLUSTER: TabCluster = {
  id: 'cluster',
  name: 'Work',
  color: 'blue',
  collapsed: false,
  tabIds: ['a', 'b', 'c']
}

function ChipsFromStore(): React.JSX.Element {
  const group = store((state) => state.groupsByWorktree.wt?.find((pane) => pane.id === 'pane'))
  return (
    <>
      {group?.tabClusters?.map((cluster) => (
        <TabClusterChip
          key={cluster.id}
          cluster={cluster}
          groupId="pane"
          worktreeId="wt"
          onClose={() => {}}
        />
      ))}
    </>
  )
}

function pane(): TabGroup {
  return store.getState().groupsByWorktree.wt[0]
}

function mount(cluster: TabCluster = CLUSTER, activeTabId = 'a'): RenderResult {
  const tabOrder = [...cluster.tabIds, 'x']
  seedStore(store, {
    activeWorktreeId: 'wt',
    unifiedTabsByWorktree: {
      wt: tabOrder.map((id, sortOrder) =>
        makeUnifiedTab({ id, sortOrder, worktreeId: 'wt', groupId: 'pane', contentType: 'editor' })
      )
    },
    groupsByWorktree: {
      wt: [
        makeTabGroup({
          id: 'pane',
          worktreeId: 'wt',
          activeTabId,
          tabOrder,
          tabClusters: [cluster]
        })
      ]
    }
  })
  return render(
    <TooltipProvider>
      <ChipsFromStore />
    </TooltipProvider>
  )
}

function openRename(): void {
  act(() => store.getState().setRenamingTabCluster({ groupId: 'pane', clusterId: CLUSTER.id }))
}

beforeEach(() => {
  vi.clearAllMocks()
  store = createTestStore()
})
afterEach(cleanup)

describe('cluster chip rename', () => {
  it('retains an explicit rename request until its chip mounts, then consumes it once', () => {
    store.getState().setRenamingTabCluster({ groupId: 'pane', clusterId: CLUSTER.id })
    const view = mount({ ...CLUSTER, name: '' })
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    expect(input).toBe(screen.getByDisplayValue(''))
    expect(store.getState().renamingTabCluster).toBeNull()
    fireEvent.keyDown(input, { key: 'Escape' })
    view.unmount()
    render(
      <TooltipProvider>
        <ChipsFromStore />
      </TooltipProvider>
    )
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('consumes a mounted chip request without replacing an in-progress name', () => {
    mount()
    openRename()
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    fireEvent.change(input, { target: { value: 'Research' } })
    openRename()
    expect(screen.getByDisplayValue('Research')).toBe(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(pane().tabClusters?.[0].name).toBe('Research')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('leaves a different pane rename request pending', () => {
    mount()
    const request = { groupId: 'other', clusterId: CLUSTER.id }
    act(() => store.getState().setRenamingTabCluster(request))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(store.getState().renamingTabCluster).toEqual(request)
  })

  it('does not open rename when moving an unnamed cluster rekeys a colliding id', () => {
    mount()
    const otherCluster: TabCluster = {
      ...CLUSTER,
      name: '',
      tabIds: ['other-a', 'other-b']
    }
    const state = store.getState()
    act(() =>
      seedStore(store, {
        groupsByWorktree: {
          wt: [
            ...state.groupsByWorktree.wt,
            makeTabGroup({
              id: 'other',
              worktreeId: 'wt',
              activeTabId: 'other-a',
              tabOrder: otherCluster.tabIds,
              tabClusters: [otherCluster]
            })
          ]
        },
        unifiedTabsByWorktree: {
          wt: [
            ...state.unifiedTabsByWorktree.wt,
            ...otherCluster.tabIds.map((id) =>
              makeUnifiedTab({ id, groupId: 'other', worktreeId: 'wt', contentType: 'editor' })
            )
          ]
        }
      })
    )
    const chip = screen.getByRole('button', { name: 'Work' })
    act(() => chip.focus())
    act(() => store.getState().moveTabCluster('other', CLUSTER.id, { groupId: 'pane' }))
    const moved = pane().tabClusters?.find((cluster) => cluster.tabIds.includes('other-a'))
    expect(moved?.id).not.toBe(CLUSTER.id)
    expect(moved?.name).toBe('')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Unnamed group' })).toBeDefined()
    expect(document.activeElement).toBe(chip)
  })

  it('keeps a restored unnamed cluster color-only without taking rename focus', () => {
    mount({ ...CLUSTER, name: '' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Unnamed group' }).getAttribute('aria-expanded')
    ).toBe('true')
  })

  it('commits a trimmed name on Enter and leaves the editing state', () => {
    mount()
    openRename()
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    fireEvent.change(input, { target: { value: '  Research  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(pane().tabClusters?.[0].name).toBe('Research')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('commits on blur, including an intentionally empty color-only name', () => {
    mount()
    openRename()
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(pane().tabClusters?.[0].name).toBe('')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('cancels on Escape without committing the discarded name', () => {
    mount()
    openRename()
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    fireEvent.change(input, { target: { value: 'Discard me' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(pane().tabClusters?.[0].name).toBe('Work')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it.each(['before', 'after'])(
    'keeps the IME redispatch %s keyup from committing rename',
    (redispatchTiming) => {
      mount()
      openRename()
      const input = screen.getByRole('textbox', { name: 'Rename Group' })
      fireEvent.compositionStart(input)
      fireEvent.change(input, { target: { value: '調査' } })
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
      fireEvent.compositionEnd(input, { data: '調査' })
      expect(pane().tabClusters?.[0].name).toBe('Work')
      expect(screen.getByRole('textbox')).toBe(input)
      if (redispatchTiming === 'after') {
        fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
      }
      fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 13 })
      expect(pane().tabClusters?.[0].name).toBe('Work')
      expect(screen.getByRole('textbox')).toBe(input)
      fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
      expect(pane().tabClusters?.[0].name).toBe('調査')
      expect(screen.queryByRole('textbox')).toBeNull()
    }
  )
})

describe('cluster chip presentation', () => {
  it('exposes a collapsed group state and member count', () => {
    mount({ ...CLUSTER, collapsed: true })
    const chip = screen.getByRole('button', { name: 'Work' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(chip.textContent).toContain('3')
  })
})

describe('cluster chip floating titlebar interactions', () => {
  it.each(['chip', 'label'])(
    'does not drag or maximize the floating panel from the %s',
    (targetKind) => {
      const view = mount()
      const previewUserBounds = vi.fn()
      const commitUserBounds = vi.fn()
      const toggleMaximized = vi.fn()
      const actions = createFloatingTerminalPanelDragActions({
        maximized: false,
        dragRef: { current: null },
        bounds: { left: 120, top: 96, width: 760, height: 420 },
        focusPanelForShortcuts: vi.fn(),
        previewUserBounds,
        commitUserBounds,
        toggleMaximized
      })
      view.rerender(
        <TooltipProvider>
          <div
            data-testid="floating-titlebar"
            onPointerDown={actions.handleDragStart}
            onPointerMove={actions.handleDragMove}
            onPointerUp={actions.handleDragEnd}
            onDoubleClick={actions.handleTitlebarDoubleClick}
          >
            <ChipsFromStore />
          </div>
        </TooltipProvider>
      )
      const titlebar = screen.getByTestId('floating-titlebar')
      const setPointerCapture = vi.fn()
      titlebar.setPointerCapture = setPointerCapture
      const target =
        targetKind === 'chip'
          ? screen.getByRole('button', { name: 'Work' })
          : screen.getByText('Work')

      fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 20 })
      fireEvent.pointerMove(titlebar, { pointerId: 1, clientX: 34, clientY: 32 })
      fireEvent.pointerUp(titlebar, { pointerId: 1, clientX: 34, clientY: 32 })
      fireEvent.doubleClick(target, { button: 0 })

      expect(setPointerCapture).not.toHaveBeenCalled()
      expect(previewUserBounds).not.toHaveBeenCalled()
      expect(commitUserBounds).not.toHaveBeenCalled()
      expect(toggleMaximized).not.toHaveBeenCalled()
    }
  )
})

describe('cluster chip context menu dismissal', () => {
  it.each([
    { label: 'named', name: 'Work' },
    { label: 'unnamed', name: '' }
  ])(
    'returns focus to the $label chip when Escape dismisses a keyboard-opened menu',
    async ({ name }) => {
      mount({ ...CLUSTER, name })
      const chip = screen.getByRole('button', { name: name || 'Unnamed group' })
      act(() => chip.focus())
      fireEvent.keyDown(chip, { key: 'ContextMenu' })
      // Why: happy-dom does not dispatch contextmenu for keyboard shortcuts.
      fireEvent.contextMenu(chip, { button: 0 })
      const menu = await screen.findByRole('menu')
      await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))
      fireEvent.keyDown(menu, { key: 'Escape' })
      await waitFor(() => {
        expect(screen.queryByRole('menu')).toBeNull()
        expect(document.activeElement).toBe(chip)
      })
    }
  )

  it.each([
    { label: 'close-all-context-menus', eventType: CLOSE_ALL_CONTEXT_MENUS_EVENT },
    { label: 'window blur', eventType: 'blur' }
  ])('closes on $label and can reopen on right-click', async ({ eventType }) => {
    mount()
    const chip = screen.getByRole('button', { name: 'Work' })
    fireEvent.contextMenu(chip)
    expect(await screen.findByRole('menu')).toBeDefined()
    fireEvent.contextMenu(chip)
    expect(screen.getByRole('menu')).toBeDefined()
    act(() => window.dispatchEvent(new Event(eventType)))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    fireEvent.contextMenu(chip)
    expect(await screen.findByRole('menu')).toBeDefined()
    expect(pane().tabClusters).toEqual([CLUSTER])
  })
})
