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

it('sets and clears a section color and toggles name coloring on the row owner host', async () => {
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
  const menu = () => (
    <ProjectGroupHeaderMenu
      groupId="group-1"
      hostId="runtime:studio"
      label="Projects"
      projectGroup={projectGroup}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />
  )
  const view = render(menu())
  const openColors = async () => {
    await waitFor(() =>
      expect(
        view
          .getByRole('button', { name: 'Group actions for Projects' })
          .getAttribute('aria-expanded')
      ).toBe('false')
    )
    fireEvent.keyDown(view.getByRole('button', { name: 'Group actions for Projects' }), {
      key: 'ArrowDown'
    })
    fireEvent.keyDown(await view.findByRole('menuitem', { name: 'Color' }), { key: 'ArrowRight' })
  }

  await openColors()
  expect(view.queryByRole('menuitemcheckbox', { name: 'Color the name too' })).toBeNull()
  fireEvent.keyDown(await view.findByRole('menuitemcheckbox', { name: 'Red' }), { key: 'Enter' })
  expect(updateProjectGroup).toHaveBeenLastCalledWith(
    'group-1',
    { color: '#ef4444' },
    { hostId: 'runtime:studio' }
  )

  projectGroup.color = '#ef4444'
  view.rerender(menu())
  await openColors()
  fireEvent.click(await view.findByRole('menuitemcheckbox', { name: 'Color the name too' }))
  expect(updateProjectGroup).toHaveBeenLastCalledWith(
    'group-1',
    { colorName: true },
    { hostId: 'runtime:studio' }
  )

  projectGroup.colorName = true
  view.rerender(menu())
  await openColors()
  fireEvent.click(await view.findByRole('menuitemcheckbox', { name: 'Color the name too' }))
  expect(updateProjectGroup).toHaveBeenLastCalledWith(
    'group-1',
    { colorName: false },
    { hostId: 'runtime:studio' }
  )

  await openColors()
  fireEvent.click(await view.findByRole('menuitemcheckbox', { name: 'No color' }))
  expect(updateProjectGroup).toHaveBeenLastCalledWith(
    'group-1',
    { color: null },
    { hostId: 'runtime:studio' }
  )
})
