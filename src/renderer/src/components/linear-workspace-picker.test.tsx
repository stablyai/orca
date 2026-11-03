// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LinearWorkspacePicker } from './linear-workspace-picker'

afterEach(cleanup)

it('offers All and each workspace, and keeps the scope control for a single workspace', async () => {
  const first = {
    id: 'first',
    organizationId: 'first',
    organizationName: 'First workspace',
    displayName: 'First user',
    email: null
  }
  const second = { ...first, id: 'second', organizationName: 'Second workspace' }
  const onChange = vi.fn()
  const { rerender } = render(
    <LinearWorkspacePicker workspaces={[first, second]} value="all" onChange={onChange} />
  )
  const trigger = screen.getByRole('combobox', { name: 'Linear workspace' })
  expect(trigger.textContent).toBe('All Linear workspaces')
  fireEvent.click(trigger)
  fireEvent.change(screen.getByPlaceholderText('Search Linear workspaces'), {
    target: { value: 'Second' }
  })
  fireEvent.click(await screen.findByRole('option', { name: 'Second workspace' }))
  expect(onChange).toHaveBeenCalledWith('second')
  await waitFor(() => expect(screen.queryByRole('option')).toBeNull())

  rerender(<LinearWorkspacePicker workspaces={[second]} value="second" onChange={onChange} />)
  expect(trigger.textContent).toBe('Second workspace')
  onChange.mockClear()
  rerender(<LinearWorkspacePicker workspaces={[first]} value="second" onChange={onChange} />)
  expect(trigger.textContent).toBe('Unavailable Linear workspace')
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name: 'All Linear workspaces' }))
  expect(onChange).toHaveBeenLastCalledWith('all')
})
