import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SparsePreset } from '../../../../shared/types'
import { SparsePresetSettingsSection } from './SparsePresetSettingsSection'

const storeMock = vi.hoisted(() => ({
  state: {
    sparsePresetsByRepo: {} as Record<string, SparsePreset[]>,
    sparsePresetsLoadStatusByRepo: {} as Record<string, 'idle' | 'loading' | 'loaded' | 'error'>,
    sparsePresetsErrorByRepo: {} as Record<string, string | undefined>,
    fetchSparsePresets: vi.fn(),
    saveSparsePreset: vi.fn(),
    removeSparsePreset: vi.fn()
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

describe('SparsePresetSettingsSection', () => {
  beforeEach(() => {
    storeMock.state.sparsePresetsByRepo = {}
    storeMock.state.sparsePresetsLoadStatusByRepo = {}
    storeMock.state.sparsePresetsErrorByRepo = {}
    storeMock.state.fetchSparsePresets.mockReset()
    storeMock.state.saveSparsePreset.mockReset()
    storeMock.state.removeSparsePreset.mockReset()
  })

  it('surfaces sparse preset load failures inline instead of showing an endless loader', () => {
    storeMock.state.sparsePresetsLoadStatusByRepo = { 'repo-1': 'error' }
    storeMock.state.sparsePresetsErrorByRepo = { 'repo-1': 'disk failed' }

    const markup = renderToStaticMarkup(<SparsePresetSettingsSection repoId="repo-1" />)

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('disk failed')
    expect(markup).toContain('Sparse presets could not be loaded.')
  })
})
