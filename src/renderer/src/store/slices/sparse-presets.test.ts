import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SparsePreset } from '../../../../shared/types'
import type { AppState } from '../types'
import { createSparsePresetsSlice } from './sparse-presets'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const mockApi = {
  sparsePresets: {
    list: vi.fn(),
    save: vi.fn(),
    remove: vi.fn()
  }
}

// @ts-expect-error -- test shim
globalThis.window = { api: mockApi }

function createTestStore() {
  return create<AppState>()((...a) => ({ ...createSparsePresetsSlice(...a) }) as AppState)
}

function makePreset(
  overrides: Partial<SparsePreset> & { id: string; repoId: string }
): SparsePreset {
  return {
    name: overrides.id,
    directories: ['packages/app'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('createSparsePresetsSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.sparsePresets.list.mockResolvedValue([])
    mockApi.sparsePresets.save.mockImplementation((args: Partial<SparsePreset>) =>
      Promise.resolve(
        makePreset({
          id: args.id ?? `preset-${args.name}`,
          repoId: args.repoId ?? 'repo-1',
          name: args.name ?? 'Preset',
          directories: args.directories ?? ['packages/app'],
          updatedAt: 2
        })
      )
    )
    mockApi.sparsePresets.remove.mockResolvedValue(undefined)
  })

  it('fetches presets into the requested repo bucket', async () => {
    const store = createTestStore()
    const preset = makePreset({ id: 'preset-1', repoId: 'repo-1', name: 'Web' })
    mockApi.sparsePresets.list.mockResolvedValueOnce([preset])

    await store.getState().fetchSparsePresets('repo-1')

    expect(mockApi.sparsePresets.list).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(store.getState().sparsePresetsByRepo).toEqual({ 'repo-1': [preset] })
  })

  it('saves presets per repo and sorts the repo list by name', async () => {
    const store = createTestStore()
    store.setState({
      sparsePresetsByRepo: {
        'repo-1': [makePreset({ id: 'z', repoId: 'repo-1', name: 'Zed' })],
        'repo-2': [makePreset({ id: 'other', repoId: 'repo-2', name: 'Other' })]
      }
    } as Partial<AppState>)

    const saved = await store.getState().saveSparsePreset({
      repoId: 'repo-1',
      name: 'Api',
      directories: ['packages/api']
    })

    expect(saved?.name).toBe('Api')
    expect(store.getState().sparsePresetsByRepo['repo-1'].map((preset) => preset.name)).toEqual([
      'Api',
      'Zed'
    ])
    expect(store.getState().sparsePresetsByRepo['repo-2'].map((preset) => preset.name)).toEqual([
      'Other'
    ])
  })

  it('restores the previous repo presets when remove fails', async () => {
    const store = createTestStore()
    const preset = makePreset({ id: 'preset-1', repoId: 'repo-1', name: 'Web' })
    mockApi.sparsePresets.remove.mockRejectedValueOnce(new Error('disk failed'))
    store.setState({ sparsePresetsByRepo: { 'repo-1': [preset] } } as Partial<AppState>)

    await store.getState().removeSparsePreset({ repoId: 'repo-1', presetId: 'preset-1' })

    expect(store.getState().sparsePresetsByRepo['repo-1']).toEqual([preset])
  })
})
