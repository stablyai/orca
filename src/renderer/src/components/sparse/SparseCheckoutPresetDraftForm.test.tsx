// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SparseCheckoutPresetDraftForm } from './SparseCheckoutPresetDraftForm'

afterEach(cleanup)
const callbacks = { onDraftChange: vi.fn(), onSave: vi.fn(), onCancel: vi.fn() }

it('keeps an untouched new preset neutral and reveals the name error on blur', () => {
  render(
    <SparseCheckoutPresetDraftForm
      {...callbacks}
      draft={{ mode: 'new', name: '', directoriesText: '' }}
      parsedDirectories={{ directories: [], error: 'Add at least one directory.' }}
      nameError="Name is required."
      submitting={false}
      canSave={false}
    />
  )
  expect(screen.queryByText('Name is required.')).toBeNull()
  // Why: an empty draft has nothing to be wrong with yet — the list states it plainly.
  expect(screen.queryByText('Add at least one directory.')).toBeNull()
  expect(screen.getByText('No folders added yet.')).toBeTruthy()
  fireEvent.blur(screen.getByLabelText('Name'))
  expect(screen.getByText('Name is required.')).toBeTruthy()
})

it('keeps a save failure alongside the retained draft', () => {
  render(
    <SparseCheckoutPresetDraftForm
      {...callbacks}
      draft={{ mode: 'edit', name: 'Web', directoriesText: 'apps/web' }}
      parsedDirectories={{ directories: ['apps/web'], error: null }}
      nameError={null}
      submitting={false}
      canSave={true}
      operationError="Could not save the preset. Try again."
    />
  )
  expect(screen.getByRole('alert').textContent).toContain('Try again')
  expect(screen.getByText('apps/web')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save preset' }).hasAttribute('disabled')).toBe(false)
})

it('removes a selected directory from the draft', () => {
  const onDraftChange = vi.fn()
  render(
    <SparseCheckoutPresetDraftForm
      {...callbacks}
      onDraftChange={onDraftChange}
      draft={{ mode: 'edit', name: 'Web', directoriesText: 'apps/web\npackages/ui' }}
      parsedDirectories={{ directories: ['apps/web', 'packages/ui'], error: null }}
      nameError={null}
      submitting={false}
      canSave={true}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove apps/web' }))
  expect(onDraftChange).toHaveBeenCalledWith(
    expect.objectContaining({ directoriesText: 'packages/ui' })
  )
})

it('disables the folder picker until a repository root is known', () => {
  const { rerender } = render(
    <SparseCheckoutPresetDraftForm
      {...callbacks}
      draft={{ mode: 'new', name: '', directoriesText: '' }}
      parsedDirectories={{ directories: [], error: null }}
      nameError={null}
      submitting={false}
      canSave={false}
    />
  )
  expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  rerender(
    <SparseCheckoutPresetDraftForm
      {...callbacks}
      draft={{ mode: 'new', name: '', directoriesText: '' }}
      parsedDirectories={{ directories: [], error: null }}
      nameError={null}
      submitting={false}
      canSave={false}
      repoRootPath="/repo"
    />
  )
  expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false)
})

it('opens a preset saved before the chip editor with every directory intact', () => {
  const onDraftChange = vi.fn()
  const saved = ['apps/web', 'packages/ui', 'packages/design-tokens']
  render(
    <SparseCheckoutPresetDraftForm
      {...callbacks}
      onDraftChange={onDraftChange}
      draft={{ mode: 'edit', name: 'Legacy', directoriesText: saved.join('\n') }}
      parsedDirectories={{ directories: saved, error: null }}
      nameError={null}
      submitting={false}
      canSave={true}
    />
  )
  // Why: presets predate the chip editor, so the stored string[] must survive untouched.
  for (const directory of saved) {
    expect(screen.getByRole('button', { name: `Remove ${directory}` })).toBeTruthy()
  }
  expect(screen.getByRole('button', { name: 'Save preset' }).hasAttribute('disabled')).toBe(false)
  expect(onDraftChange).not.toHaveBeenCalled()
})
