// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeUnifiedTab,
  seedStore,
  type TestStore
} from '@/store/slices/store-test-helpers'
import type { TabCluster, TabGroup } from '../../../../shared/tab-types'
import { TabClusterChip } from './TabClusterChip'
import { TabClusterMenuSection } from './TabClusterMenuSection'
import { useTabClusterMenuCloseAction } from './use-tab-cluster-menu-close-action'

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

const PANE: TabGroup = {
  id: 'pane',
  worktreeId: 'wt',
  activeTabId: 'a',
  tabOrder: ['a', 'b', 'c']
}
const CLUSTER: TabCluster = {
  id: 'existing-cluster',
  name: 'Work',
  color: 'blue',
  collapsed: false,
  tabIds: ['a', 'b']
}
const MENU_EXIT_ANIMATION = `
  [data-slot="dropdown-menu-content"][data-state="open"],
  [data-slot="context-menu-content"][data-state="open"] { animation-name: none; }
  [data-slot="dropdown-menu-content"][data-state="closed"],
  [data-slot="context-menu-content"][data-state="closed"] {
    animation-name: cluster-menu-close;
    animation-duration: 0.2s;
  }
`

function ChipsFromStore(): React.JSX.Element {
  const clusters = store((state) => state.groupsByWorktree.wt[0].tabClusters)
  return (
    <>
      {clusters?.map((cluster) => (
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

function CreationMenu(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const clusterMenuAction = useTabClusterMenuCloseAction()
  return (
    <TooltipProvider>
      <style>{MENU_EXIT_ANIMATION}</style>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button>Tab menu</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onCloseAutoFocus={clusterMenuAction.runAfterClose}>
          {open ? (
            <TabClusterMenuSection
              worktreeId="wt"
              groupId="pane"
              tabId="a"
              isPinned={false}
              onQueueNewCluster={clusterMenuAction.queueAfterClose}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ChipsFromStore />
    </TooltipProvider>
  )
}

function finishMenuExit(menu: HTMLElement): void {
  const event = new Event('animationend', { bubbles: true })
  Object.defineProperty(event, 'animationName', { value: 'cluster-menu-close' })
  fireEvent(menu, event)
}

beforeEach(() => {
  store = createTestStore()
  seedStore(store, {
    activeWorktreeId: 'wt',
    groupsByWorktree: { wt: [PANE] },
    unifiedTabsByWorktree: {
      wt: PANE.tabOrder.map((id) =>
        makeUnifiedTab({ id, groupId: 'pane', worktreeId: 'wt', contentType: 'editor' })
      )
    },
    tabSelectionByGroupId: { pane: { tabIds: ['a', 'b'], anchorTabId: 'a' } }
  })
})
afterEach(cleanup)

describe('cluster rename after a closing menu', () => {
  it('creates the group after menu exit and focuses only its new name field', async () => {
    store.setState({
      groupsByWorktree: {
        wt: [{ ...PANE, tabClusters: [{ ...CLUSTER, name: '', tabIds: ['c'] }] }]
      }
    })
    render(<CreationMenu />)
    const menu = await screen.findByRole('menu')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add 2 Tabs to New Group' }))
    expect(menu.getAttribute('data-state')).toBe('closed')
    expect(screen.queryByRole('textbox', { name: 'Rename Group' })).toBeNull()
    expect(store.getState().groupsByWorktree.wt[0].tabClusters).toHaveLength(1)
    finishMenuExit(menu)

    const input = await screen.findByRole('textbox', { name: 'Rename Group' })
    const created = store
      .getState()
      .groupsByWorktree.wt[0].tabClusters?.find((cluster) => cluster.tabIds.includes('a'))
    expect(created?.tabIds).toEqual(['a', 'b'])
    expect(input.getAttribute('data-tab-cluster-rename-input')).toBe(created?.id)
    expect(screen.getAllByRole('textbox')).toEqual([input])
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: 'Research' } })
    expect(screen.getByDisplayValue('Research')).toBe(input)
    expect(
      store
        .getState()
        .groupsByWorktree.wt[0].tabClusters?.find((cluster) => cluster.id === created?.id)?.name
    ).toBe('')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(
      store
        .getState()
        .groupsByWorktree.wt[0].tabClusters?.find((cluster) => cluster.id === created?.id)?.name
    ).toBe('Research')
    expect(
      store
        .getState()
        .groupsByWorktree.wt[0].tabClusters?.find((cluster) => cluster.id === CLUSTER.id)?.name
    ).toBe('')
  })

  it('opens an existing group rename after its chip menu exits without committing on blur', async () => {
    store.setState({ groupsByWorktree: { wt: [{ ...PANE, tabClusters: [CLUSTER] }] } })
    render(
      <TooltipProvider>
        <style>{MENU_EXIT_ANIMATION}</style>
        <ChipsFromStore />
      </TooltipProvider>
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Work' }))
    const menu = await screen.findByRole('menu')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Group' }))
    expect(menu.getAttribute('data-state')).toBe('closed')
    expect(screen.queryByRole('textbox', { name: 'Rename Group' })).toBeNull()
    finishMenuExit(menu)
    const input = await screen.findByRole('textbox', { name: 'Rename Group' })
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(screen.getByDisplayValue('Work')).toBe(input)
    fireEvent.change(input, { target: { value: 'Research' } })
    expect(screen.getByDisplayValue('Research')).toBe(input)
    expect(store.getState().groupsByWorktree.wt[0].tabClusters?.[0].name).toBe('Work')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(store.getState().groupsByWorktree.wt[0].tabClusters?.[0].name).toBe('Research')
  })
})
