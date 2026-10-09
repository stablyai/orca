// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  seedStore,
  type TestStore
} from '@/store/slices/store-test-helpers'
import type { TabCluster, TabGroup } from '../../../../shared/tab-types'
import { TabClusterChip } from './TabClusterChip'

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

function ChipFromStore(): React.JSX.Element | null {
  const cluster = store((state) => state.groupsByWorktree.wt[0].tabClusters?.[0])
  return cluster ? (
    <TabClusterChip cluster={cluster} groupId="pane" worktreeId="wt" onClose={() => {}} />
  ) : null
}

function pane(): TabGroup {
  return store.getState().groupsByWorktree.wt[0]
}

function mount(cluster: TabCluster = CLUSTER, activeTabId = 'a'): void {
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
  render(
    <TooltipProvider>
      <ChipFromStore />
    </TooltipProvider>
  )
}

function pressChip(detail: number, releaseX = 11): HTMLElement {
  const chip = screen.getByRole('button', { name: 'Work' })
  fireEvent.pointerDown(chip, { button: 0, clientX: 10, clientY: 10 })
  fireEvent.pointerUp(window, { button: 0, clientX: releaseX, clientY: 10 })
  fireEvent.click(chip, { button: 0, detail })
  return chip
}

beforeEach(() => {
  vi.clearAllMocks()
  store = createTestStore()
})
afterEach(cleanup)

describe('cluster chip gestures', () => {
  it('toggles a click released within the drag threshold without starting rename', () => {
    mount()
    const chip = screen.getByRole('button', { name: 'Work' })
    fireEvent.pointerDown(chip, { button: 0, clientX: 10, clientY: 10 })
    expect(pane().tabClusters).toEqual([CLUSTER])
    fireEvent.pointerUp(window, { button: 0, clientX: 11, clientY: 10 })
    fireEvent.click(chip, { detail: 1 })
    expect(pane().tabClusters?.[0]).toMatchObject({ collapsed: true, shownTabId: 'a' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox')).toBeNull()
    pressChip(1)
    expect(pane().tabClusters).toEqual([CLUSTER])
    expect(chip.getAttribute('aria-expanded')).toBe('true')
  })

  it('toggles a double click twice without opening rename', () => {
    mount({ ...CLUSTER, collapsed: true, shownTabId: 'a' })
    const chip = pressChip(1)
    expect(pane().tabClusters?.[0].collapsed).toBe(false)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('textbox')).toBeNull()
    pressChip(2)
    fireEvent.doubleClick(chip, { detail: 2 })
    expect(pane().tabClusters?.[0]).toMatchObject({ collapsed: true, shownTabId: 'a' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it.each([15, 30])(
    'does not toggle a drag released at x=%i, even if click follows',
    (releaseX) => {
      mount()
      pressChip(1, releaseX)
      expect(pane().tabClusters).toEqual([CLUSTER])
      expect(screen.queryByRole('textbox')).toBeNull()
      pressChip(1)
      expect(pane().tabClusters?.[0].collapsed).toBe(true)
    }
  )

  it('leaves the first click toggle unchanged when the second press becomes a drag', () => {
    mount()
    pressChip(1)
    const beforeDrag = pane().tabClusters
    pressChip(2, 30)
    expect(pane().tabClusters).toEqual(beforeDrag)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it.each(['Enter', ' '])('toggles the focused chip with %j', (key) => {
    mount()
    const chip = screen.getByRole('button', { name: 'Work' })
    act(() => chip.focus())
    fireEvent.keyDown(chip, { key })
    expect(pane().tabClusters?.[0]).toMatchObject({ collapsed: true, shownTabId: 'a' })
    fireEvent.keyDown(chip, { key })
    expect(pane().tabClusters).toEqual([CLUSTER])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('toggles an assistive-technology click without a pointer press', () => {
    mount()
    const chip = screen.getByRole('button', { name: 'Work' })
    fireEvent.click(chip, { detail: 0 })
    expect(pane().tabClusters?.[0]).toMatchObject({ collapsed: true, shownTabId: 'a' })
    fireEvent.click(chip, { detail: 0 })
    expect(pane().tabClusters).toEqual([CLUSTER])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not toggle or reopen while editing, including a press already in flight', () => {
    mount()
    const chip = screen.getByRole('button', { name: 'Work' })
    fireEvent.pointerDown(chip, { button: 0, clientX: 10, clientY: 10 })
    act(() => store.getState().setRenamingTabCluster({ groupId: 'pane', clusterId: CLUSTER.id }))
    const input = screen.getByRole('textbox', { name: 'Rename Group' })
    fireEvent.change(input, { target: { value: 'Draft' } })
    fireEvent.pointerUp(window, { button: 0, clientX: 11, clientY: 10 })
    fireEvent.click(chip, { detail: 2 })
    pressChip(1)
    pressChip(2)
    fireEvent.keyDown(chip, { key: 'Enter' })
    fireEvent.keyDown(chip, { key: ' ' })
    fireEvent.click(chip, { detail: 0 })
    expect(pane().tabClusters).toEqual([CLUSTER])
    expect(screen.getByDisplayValue('Draft')).toBe(input)
  })
})
