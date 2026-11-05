// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { buildGoldenStoreState } from '../parity/sidebar-list-golden-store.test-fixture'
import { ProjectCollapseMenuItems } from '../rows/project-collapse-actions'
import { useRepoHeaderProjectActions } from '../viewport/use-project-actions'
import type { VirtualizedWorktreeViewportProps } from '../viewport/viewport-props'
import WorktreeList from './WorktreeList'

vi.mock('../viewport/VirtualizedWorktreeViewport', () => ({
  VirtualizedWorktreeViewport(props: VirtualizedWorktreeViewportProps) {
    const actions = useRepoHeaderProjectActions(props)
    return (
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <ProjectCollapseMenuItems getRows={actions.getSidebarRows} />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
}))

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

it('expands projects on a collapsed host while keeping the host and filtered projects collapsed', () => {
  vi.stubGlobal('api', { ui: { set: vi.fn().mockResolvedValue(undefined) } })
  useAppStore.setState(
    buildGoldenStoreState(
      {
        groupBy: 'repo',
        sortBy: 'manual',
        projectOrderBy: 'manual',
        pinnedInGroups: false,
        collapsedGroups: new Set(['host:runtime:env-1', 'project:repo:api', 'project:repo:lab'])
      },
      {
        visibleWorkspaceHostIds: ['local', 'runtime:env-1'],
        filterRepoIds: ['api', 'ext'],
        folderWorkspaces: []
      }
    )
  )
  const confirm = vi.fn()
  const view = render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <WorktreeList scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
    </ConfirmationDialogContext.Provider>
  )

  fireEvent.click(view.getByRole('menuitem', { name: 'Expand all projects' }))

  expect(useAppStore.getState().collapsedGroups).toEqual(
    new Set(['host:runtime:env-1', 'project:repo:lab'])
  )
})
