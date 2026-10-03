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
import { requestTabClusterRename } from './tab-cluster-rename-request'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'

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
vi.mock('./SortableTab', () => ({ CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca-close-all-context-menus' }))
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

function pressChip(detail: number): void {
  const chip = screen.getByRole('button', { name: 'Work' })
  const pointer = { button: 0, clientX: 10, clientY: 10 }
  fireEvent.pointerDown(chip, pointer)
  fireEvent.mouseDown(chip, { ...pointer, detail })
  fireEvent.pointerUp(chip, pointer)
  fireEvent.mouseUp(chip, { ...pointer, detail })
  fireEvent.click(chip, { detail })
}

beforeEach(() => {
  vi.clearAllMocks()
  store = createTestStore()
})
afterEach(cleanup)

describe('cluster chip rename', () => {
  it('retains an explicit rename request until its chip mounts, then consumes it once', () => {
    requestTabClusterRename('wt', 'pane', CLUSTER.id)
    const view = mount({ ...CLUSTER, name: '' })
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    expect(input).toBe(screen.getByDisplayValue(''))
    fireEvent.keyDown(input, { key: 'Escape' })
    view.unmount()
    render(
      <TooltipProvider>
        <ChipsFromStore />
      </TooltipProvider>
    )
    expect(screen.queryByRole('textbox')).toBeNull()
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

  it.each([
    { label: 'expanded', cluster: CLUSTER, activeTabId: 'a' },
    {
      label: 'collapsed with an outside tab active',
      cluster: { ...CLUSTER, collapsed: true, shownTabId: 'a' },
      activeTabId: 'x'
    },
    {
      label: 'collapsed with another member active',
      cluster: { ...CLUSTER, collapsed: true, shownTabId: 'a' },
      activeTabId: 'b'
    }
  ])(
    'preserves $label presentation through double-click rename and Escape',
    ({ cluster, activeTabId }) => {
      mount(cluster, activeTabId)
      const before = pane().tabClusters
      pressChip(1)
      expect(pane().tabClusters?.[0].collapsed).toBe(!cluster.collapsed)
      pressChip(2)
      fireEvent.doubleClick(screen.getByRole('button', { name: 'Work' }))
      const input = screen.getByRole('textbox', { name: 'Rename Group' })
      expect(pane().tabClusters).toEqual(before)
      expect(pane().activeTabId).toBe(activeTabId)
      fireEvent.change(input, { target: { value: 'Discard me' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      fireEvent.blur(input)
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(pane().tabClusters).toEqual(before)
      expect(pane().activeTabId).toBe(activeTabId)
    }
  )

  it('does not interpret a second press that becomes a drag as rename', () => {
    mount()
    const chip = screen.getByRole('button', { name: 'Work' })
    fireEvent.pointerDown(chip, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseDown(chip, { button: 0, detail: 2 })
    fireEvent.pointerUp(window, { clientX: 30, clientY: 10 })
    fireEvent.doubleClick(chip)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(pane().tabClusters).toEqual([CLUSTER])
  })

  it('commits a trimmed name on Enter and leaves the editing state', () => {
    mount()
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Work' }))
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    fireEvent.change(input, { target: { value: '  Research  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(pane().tabClusters?.[0].name).toBe('Research')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('commits on blur, including an intentionally empty color-only name', () => {
    mount()
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Work' }))
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(pane().tabClusters?.[0].name).toBe('')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('cancels on Escape without committing the discarded name', () => {
    mount()
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Work' }))
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
      fireEvent.doubleClick(screen.getByRole('button', { name: 'Work' }))
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

describe('cluster chip collapse activation', () => {
  it('toggles only on pointer release and suppresses a drag', () => {
    mount()
    const chip = screen.getByRole('button', { name: 'Work' })
    fireEvent.pointerDown(chip, { button: 0, clientX: 10, clientY: 10 })
    expect(pane().tabClusters?.[0].collapsed).toBe(false)
    fireEvent.pointerUp(window, { clientX: 11, clientY: 10 })
    expect(pane().tabClusters?.[0].collapsed).toBe(true)
    expect(pane().tabClusters?.[0].shownTabId).toBe('a')
    fireEvent.pointerDown(chip, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window, { clientX: 30, clientY: 10 })
    expect(pane().tabClusters?.[0].collapsed).toBe(true)
    expect(pane().tabClusters?.[0].shownTabId).toBe('a')
  })

  it('exposes expanded state and toggles a collapsed group with the keyboard', () => {
    mount({ ...CLUSTER, collapsed: true })
    const chip = screen.getByRole('button', { name: 'Work' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(chip.textContent).toContain('3')
    fireEvent.keyDown(chip, { key: ' ' })
    expect(pane().tabClusters?.[0].collapsed).toBe(false)
  })
})

describe('cluster chip context menu dismissal', () => {
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
