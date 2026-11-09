// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { SparsePreset } from '../../../../../../shared/worktree/create-types'
import { SparsePresetSettingsSection } from './SparsePresetSettingsSection'

const storeMock = vi.hoisted(() => ({
  state: {
    repos: new Array<Repo>(),
    sparsePresetsByRepo: {} as Record<string, SparsePreset[]>,
    sparsePresetsLoadStatusByRepo: {} as Record<string, 'idle' | 'loading' | 'loaded' | 'error'>,
    sparsePresetsErrorByRepo: {} as Record<string, string | undefined>,
    fetchSparsePresets: vi.fn(),
    saveSparsePreset: vi.fn(),
    removeSparsePreset: vi.fn()
  }
}))

vi.mock('../../../../store/index', () => ({
  useAppStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

afterEach(cleanup)

describe('SparsePresetSettingsSection', () => {
  beforeEach(() => {
    storeMock.state.repos = []
    storeMock.state.sparsePresetsByRepo = {}
    storeMock.state.sparsePresetsLoadStatusByRepo = {}
    storeMock.state.sparsePresetsErrorByRepo = {}
    storeMock.state.fetchSparsePresets.mockReset()
    storeMock.state.saveSparsePreset.mockReset()
    storeMock.state.removeSparsePreset.mockReset()
  })

  it('edits a preset in place and prevents replacing an unsaved draft', () => {
    storeMock.state.sparsePresetsByRepo = {
      'repo-1': ['Web', 'API'].map((name) => ({
        id: name,
        repoId: 'repo-1',
        name,
        directories: [`apps/${name}`],
        createdAt: 0,
        updatedAt: 0
      }))
    }
    Element.prototype.scrollIntoView = vi.fn()
    render(<SparsePresetSettingsSection repoId="repo-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Web' }))
    expect(screen.queryByRole('button', { name: 'Edit Web' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit API' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Delete API' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My unsaved preset' } })
    fireEvent.click(screen.getByRole('button', { name: 'Edit API' }))
    expect(screen.getByDisplayValue('My unsaved preset')).toBeTruthy()
  })
})
