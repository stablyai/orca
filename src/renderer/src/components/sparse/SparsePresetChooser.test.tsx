// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SparsePresetChooser } from './SparsePresetChooser'

const presets = [
  {
    id: 'web',
    repoId: 'repo',
    name: 'Web app',
    directories: ['apps/web'],
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 'api',
    repoId: 'repo',
    name: 'API',
    directories: ['services/backend'],
    createdAt: 0,
    updatedAt: 0
  }
]
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

function setup() {
  const onSelect = vi.fn()
  const onEdit = vi.fn()
  const onNew = vi.fn()
  render(
    <TooltipProvider>
      <SparsePresetChooser
        presets={presets}
        selectedPresetId="web"
        onSelect={onSelect}
        onEdit={onEdit}
        onNew={onNew}
        onSelectFull={vi.fn()}
      />
    </TooltipProvider>
  )
  return { onSelect, onEdit, onNew }
}

it('filters by directories while keeping preset creation reachable', async () => {
  const { onSelect, onNew } = setup()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'backend' } })
  await waitFor(() => expect(screen.queryByRole('option', { name: /Web app/ })).toBeNull())
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  expect(onSelect).toHaveBeenCalledWith(presets[1])
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'no-such-preset' } })
  await waitFor(() => expect(screen.getByText('No matching presets.')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'New preset' }))
  expect(onNew).toHaveBeenCalledOnce()
})

it('editing a preset does not also select it', () => {
  const { onSelect, onEdit } = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Edit API' }))
  expect(onEdit).toHaveBeenCalledWith(presets[1])
  expect(onSelect).not.toHaveBeenCalled()
})

it('does not select the highlighted preset when Enter activates New preset', () => {
  const { onSelect } = setup()
  fireEvent.keyDown(screen.getByRole('button', { name: 'New preset' }), { key: 'Enter' })
  expect(onSelect).not.toHaveBeenCalled()
})
