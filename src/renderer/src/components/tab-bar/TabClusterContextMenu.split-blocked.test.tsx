// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TabCluster } from '../../../../shared/tab-types'
import { TabClusterContextMenu } from './TabClusterContextMenu'

let store: TestStore

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => store(selector), {
    getState: () => store.getState()
  })
}))
vi.mock('./SortableTab', () => ({ CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca-close-all-context-menus' }))

const WT = 'repo1::/tmp/cluster-menu'
const CLUSTER: TabCluster = {
  id: 'c',
  name: 'Work',
  color: 'blue',
  collapsed: false,
  tabIds: ['a']
}

function Menu({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <TabClusterContextMenu
      cluster={CLUSTER}
      groupId="pane"
      worktreeId={worktreeId}
      open={open}
      onOpenChange={setOpen}
      onRename={() => {}}
      onClose={() => {}}
    >
      <button>Work</button>
    </TabClusterContextMenu>
  )
}

function renderMenu(worktreeId = WT, remote = false): void {
  seedStore(store, {
    activeWorktreeId: worktreeId,
    activeWorkspaceExecutionHostId: remote ? 'runtime:remote' : 'local',
    groupsByWorktree: {
      [worktreeId]: [
        makeTabGroup({
          id: 'pane',
          worktreeId,
          activeTabId: 'a',
          tabOrder: ['a', 'outside'],
          tabClusters: [CLUSTER]
        })
      ]
    },
    unifiedTabsByWorktree: {
      [worktreeId]: ['a', 'outside'].map((id) =>
        makeUnifiedTab({ id, groupId: 'pane', worktreeId, contentType: 'editor' })
      )
    }
  })
  render(
    <TooltipProvider delayDuration={0}>
      <Menu worktreeId={worktreeId} />
    </TooltipProvider>
  )
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Work' }))
}

beforeEach(() => {
  store = createTestStore()
})
afterEach(cleanup)

describe('Move Group to New Split availability', () => {
  it('greys the unavailable item out and explains a remote-server block on hover', async () => {
    renderMenu(WT, true)
    const item = screen.getByRole('menuitem', { name: 'Move Group to New Split' })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    fireEvent.pointerMove(item, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Not available for workspaces on a remote Orca server. Drag the group into an existing split instead.'
    )
    fireEvent.click(item)
    expect(store.getState().groupsByWorktree[WT]).toHaveLength(1)
    expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual(['a', 'outside'])
    expect(screen.getByRole('menu')).toBeDefined()
  })

  it.each([
    {
      label: 'remote workspaces',
      worktreeId: WT,
      remote: true,
      reason:
        'Not available for workspaces on a remote Orca server. Drag the group into an existing split instead.'
    },
    {
      label: 'the floating panel',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      remote: false,
      reason: 'Not available in the floating terminal panel.'
    }
  ])(
    'makes the reason for $label reachable by keyboard',
    async ({ worktreeId, remote, reason }) => {
      renderMenu(worktreeId, remote)
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
      const close = screen.getByRole('menuitem', { name: 'Close Group' })
      await waitFor(() => expect(document.activeElement).toBe(close))
      fireEvent.keyDown(close, { key: 'ArrowUp' })
      const ungroup = screen.getByRole('menuitem', { name: 'Ungroup' })
      await waitFor(() => expect(document.activeElement).toBe(ungroup))
      fireEvent.keyDown(ungroup, { key: 'ArrowUp' })
      const item = screen.getByRole('menuitem', { name: 'Move Group to New Split' })
      await waitFor(() => expect(document.activeElement).toBe(item))
      expect(item.getAttribute('aria-disabled')).toBe('true')
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip.textContent).toBe(reason)
      expect(item.getAttribute('aria-describedby')).toBe(tooltip.id)
      fireEvent.keyDown(item, { key: 'Enter' })
      expect(store.getState().groupsByWorktree[worktreeId]).toHaveLength(1)
      expect(store.getState().groupsByWorktree[worktreeId][0].tabOrder).toEqual(['a', 'outside'])
      expect(screen.getByRole('menu')).toBeDefined()
    }
  )

  it('moves the group to the selected split direction when available', async () => {
    renderMenu()
    const trigger = screen.getByRole('menuitem', { name: 'Move Group to New Split' })
    expect(trigger.getAttribute('aria-disabled')).toBeNull()
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Right' }))
    const groups = store.getState().groupsByWorktree[WT]
    expect(groups.find((group) => group.id === 'pane')?.tabOrder).toEqual(['outside'])
    expect(groups.find((group) => group.id !== 'pane')).toMatchObject({
      tabOrder: ['a'],
      tabClusters: [CLUSTER]
    })
    expect(store.getState().layoutByWorktree[WT]).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'pane' },
      second: { type: 'leaf', groupId: groups.find((group) => group.id !== 'pane')?.id }
    })
  })
})
