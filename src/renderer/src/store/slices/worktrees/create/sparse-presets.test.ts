import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SparsePreset } from '../../../../../../shared/worktree/create-types'
import type { AppState } from '../../../types'
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

  it('loads an unfetched repo bucket before saving so existing presets stay visible', async () => {
    const store = createTestStore()
    const existing = makePreset({ id: 'existing', repoId: 'repo-1', name: 'Existing' })
    mockApi.sparsePresets.list.mockResolvedValueOnce([existing])

    const saved = await store.getState().saveSparsePreset({
      repoId: 'repo-1',
      name: 'Api',
      directories: ['packages/api']
    })

    expect(mockApi.sparsePresets.list).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(saved?.name).toBe('Api')
    expect(store.getState().sparsePresetsByRepo['repo-1'].map((preset) => preset.name)).toEqual([
      'Api',
      'Existing'
    ])
    expect(store.getState().sparsePresetsLoadStatusByRepo['repo-1']).toBe('loaded')
  })
})
