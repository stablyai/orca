// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import WorktreeList from './WorktreeList'
import { makeRepo } from './worktree-list-lineage-card-test-fixtures'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(false)
}))

vi.mock('../rows/ProjectGroupDialogs', () => ({
  SidebarWorktreeListDialogs: () => null
}))

vi.mock('../viewport/VirtualizedWorktreeViewport', () => ({
  VirtualizedWorktreeViewport: ({
    rows,
    toggleGroup
  }: {
    rows: HostSectionRow[]
    toggleGroup: (key: string) => void
  }) => (
    <>
      {rows.map((row) =>
        row.type === 'header' ? (
          <button key={row.key} onClick={() => toggleGroup(row.key)}>
            {row.key}
          </button>
        ) : null
      )}
    </>
  )
}))

const initialState = useAppStore.getInitialState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})

it('keeps the collapse-all announcement active when a parent hides its project headers', () => {
  Object.assign(window, {
    api: {
      ui: {
        set: () => Promise.resolve(),
        onToggleProjectsCollapse: () => () => {}
      }
    }
  })
  useAppStore.setState(
    {
      ...initialState,
      persistedUIReady: true,
      groupBy: 'repo',
      repos: [
        { ...makeRepo(), id: 'one', projectGroupId: 'parent' },
        { ...makeRepo(), id: 'two', projectGroupId: 'parent' }
      ],
      projectGroups: [
        {
          id: 'parent',
          name: 'Parent',
          parentPath: null,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    },
    true
  )
  const target = document.createElement('div')
  target.setAttribute('data-contextual-tour-target', 'projects-collapse-all')
  target.getBoundingClientRect = () => new DOMRect(100, 100, 150, 24)
  const { getByRole, queryByRole } = render(
    <>
      <div ref={(element) => element?.append(target)} />
      <WorktreeList
        scrollOffsetRef={{ current: 0 }}
        scrollAnchorRef={{ current: null }}
        projectsCollapseTarget={target}
      />
    </>
  )
  expect(getByRole('button', { name: 'project:repo:one' })).toBeTruthy()
  fireEvent.click(getByRole('button', { name: 'project-group:parent' }))
  expect(queryByRole('button', { name: 'project:repo:one' })).toBeNull()
  expect(queryByRole('button', { name: 'project:repo:two' })).toBeNull()
  expect(useAppStore.getState().activeContextualTourId).toBe('projects-collapse-all')
  expect(useAppStore.getState().activeContextualTourSuppressed).toBe(false)
})
