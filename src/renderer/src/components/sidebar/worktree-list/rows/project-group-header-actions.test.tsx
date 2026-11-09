// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { ProjectGroupHeaderMenu } from './project-group-header-actions'

const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('sets and clears a section color on the row owner host', async () => {
  const updateProjectGroup = vi.fn().mockResolvedValue(true)
  useAppStore.setState({ updateProjectGroup })
  const projectGroup: ProjectGroup = {
    id: 'group-1',
    name: 'Projects',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
  const view = render(
    <ProjectGroupHeaderMenu
      groupId="group-1"
      hostId="runtime:studio"
      label="Projects"
      projectGroup={projectGroup}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />
  )
  const openColors = async () => {
    fireEvent.keyDown(view.getByRole('button', { name: 'Group actions for Projects' }), {
      key: 'ArrowDown'
    })
    fireEvent.keyDown(await view.findByRole('menuitem', { name: 'Color' }), { key: 'ArrowRight' })
  }

  await openColors()
  fireEvent.click(await view.findByLabelText('Use #ef4444 section color'))
  expect(updateProjectGroup).toHaveBeenLastCalledWith(
    'group-1',
    { color: '#ef4444' },
    { hostId: 'runtime:studio' }
  )

  await waitFor(() =>
    expect(
      view.getByRole('button', { name: 'Group actions for Projects' }).getAttribute('aria-expanded')
    ).toBe('false')
  )
  await openColors()
  fireEvent.click(await view.findByText('No color'))
  expect(updateProjectGroup).toHaveBeenLastCalledWith(
    'group-1',
    { color: null },
    { hostId: 'runtime:studio' }
  )
})
