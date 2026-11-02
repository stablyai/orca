// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskPageJiraSavedFilters } from './TaskPageJiraSavedFilters'
afterEach(cleanup)
const mine = { id: 'mine', name: 'My work', jql: 'assignee = currentUser()' }
function setup(overrides: Partial<React.ComponentProps<typeof TaskPageJiraSavedFilters>> = {}) {
  const props = {
    filters: [mine],
    activeFilterId: mine.id,
    currentJql: mine.jql,
    onApply: vi.fn(async () => {}),
    onCreate: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    ...overrides
  }
  render(<TaskPageJiraSavedFilters {...props} />)
  return { user: userEvent.setup(), props }
}
it('saves another named filter and requires explicit updates to existing queries', async () => {
  const { user, props } = setup({ currentJql: 'project = APP' })
  await user.click(screen.getByRole('button', { name: 'Saved filters' }))
  await user.click(screen.getByRole('button', { name: 'Save current filter' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'App bugs')
  await user.click(screen.getByRole('button', { name: 'Save filter' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(props.onCreate).toHaveBeenCalledWith({ name: 'App bugs', jql: 'project = APP' })
  expect(props.onUpdate).not.toHaveBeenCalled()
})
it('renames, explicitly updates, and deletes a saved filter', async () => {
  const { user, props } = setup()
  await user.click(screen.getByRole('button', { name: 'Saved filters' }))
  await user.click(screen.getByRole('button', { name: 'Edit My work' }))
  await user.clear(screen.getByRole('textbox', { name: 'Name' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Open work')
  await user.clear(screen.getByRole('textbox', { name: 'JQL' }))
  await user.type(screen.getByRole('textbox', { name: 'JQL' }), 'status = Open')
  await user.click(screen.getByRole('button', { name: 'Update filter' }))
  expect(props.onUpdate).toHaveBeenCalledWith(mine.id, { name: 'Open work', jql: 'status = Open' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await user.click(screen.getByRole('button', { name: 'Saved filters' }))
  await user.click(screen.getByRole('button', { name: 'Edit My work' }))
  await user.click(screen.getByRole('button', { name: 'Delete filter' }))
  expect(props.onDelete).toHaveBeenCalledWith(mine.id)
})
