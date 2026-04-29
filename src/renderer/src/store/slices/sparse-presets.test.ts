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
    expect(store.getState().sparsePresetsLoadingByRepo['repo-1']).toBe(false)
    expect(store.getState().sparsePresetsLoadStatusByRepo['repo-1']).toBe('loaded')
    expect(store.getState().sparsePresetsErrorByRepo['repo-1']).toBeUndefined()
  })

  it('keeps an unfetched repo bucket missing while presets are loading', async () => {
    const store = createTestStore()
    const preset = makePreset({ id: 'preset-1', repoId: 'repo-1', name: 'Web' })
    let resolveList: (presets: SparsePreset[]) => void = () => {}
    mockApi.sparsePresets.list.mockReturnValueOnce(
      new Promise<SparsePreset[]>((resolve) => {
        resolveList = resolve
      })
    )

    const fetchPromise = store.getState().fetchSparsePresets('repo-1')

    expect(store.getState().sparsePresetsByRepo['repo-1']).toBeUndefined()
    expect(store.getState().sparsePresetsLoadingByRepo['repo-1']).toBe(true)
    expect(store.getState().sparsePresetsLoadStatusByRepo['repo-1']).toBe('loading')

    resolveList([preset])
    await fetchPromise

    expect(store.getState().sparsePresetsByRepo['repo-1']).toEqual([preset])
    expect(store.getState().sparsePresetsLoadingByRepo['repo-1']).toBe(false)
    expect(store.getState().sparsePresetsLoadStatusByRepo['repo-1']).toBe('loaded')
  })

  it('does not refetch while a repo bucket is loading or already loaded', async () => {
    const store = createTestStore()
    let resolveList: (presets: SparsePreset[]) => void = () => {}
    mockApi.sparsePresets.list.mockReturnValueOnce(
      new Promise<SparsePreset[]>((resolve) => {
        resolveList = resolve
      })
    )

    const fetchPromise = store.getState().fetchSparsePresets('repo-1')
    await store.getState().fetchSparsePresets('repo-1')

    expect(mockApi.sparsePresets.list).toHaveBeenCalledTimes(1)

    resolveList([])
    await fetchPromise
    await store.getState().fetchSparsePresets('repo-1')

    expect(mockApi.sparsePresets.list).toHaveBeenCalledTimes(1)
  })

  it('clears loading state without marking the repo loaded when fetch fails', async () => {
    const store = createTestStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockApi.sparsePresets.list.mockRejectedValueOnce(new Error('disk failed'))

    try {
      await store.getState().fetchSparsePresets('repo-1')

      expect(store.getState().sparsePresetsByRepo['repo-1']).toBeUndefined()
      expect(store.getState().sparsePresetsLoadingByRepo['repo-1']).toBe(false)
      expect(store.getState().sparsePresetsLoadStatusByRepo['repo-1']).toBe('error')
      expect(store.getState().sparsePresetsErrorByRepo['repo-1']).toBe('disk failed')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('clears a failed fetch status when retrying presets succeeds', async () => {
    const store = createTestStore()
    const preset = makePreset({ id: 'preset-1', repoId: 'repo-1', name: 'Web' })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockApi.sparsePresets.list
      .mockRejectedValueOnce(new Error('disk failed'))
      .mockResolvedValueOnce([preset])

    try {
      await store.getState().fetchSparsePresets('repo-1')
      await store.getState().fetchSparsePresets('repo-1')

      expect(mockApi.sparsePresets.list).toHaveBeenCalledTimes(2)
      expect(store.getState().sparsePresetsByRepo['repo-1']).toEqual([preset])
      expect(store.getState().sparsePresetsLoadStatusByRepo['repo-1']).toBe('loaded')
      expect(store.getState().sparsePresetsErrorByRepo['repo-1']).toBeUndefined()
    } finally {
      consoleError.mockRestore()
    }
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
    expect(mockApi.sparsePresets.save).toHaveBeenCalledTimes(1)
    expect(saved?.name).toBe('Api')
    expect(store.getState().sparsePresetsByRepo['repo-1'].map((preset) => preset.name)).toEqual([
      'Api',
      'Existing'
    ])
    expect(store.getState().sparsePresetsLoadStatusByRepo['repo-1']).toBe('loaded')
  })

  it('does not save or synthesize a repo bucket when presets fail to load first', async () => {
    const store = createTestStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockApi.sparsePresets.list.mockRejectedValueOnce(new Error('disk failed'))

    try {
      const saved = await store.getState().saveSparsePreset({
        repoId: 'repo-1',
        name: 'Api',
        directories: ['packages/api']
      })

      expect(saved).toBeNull()
      expect(mockApi.sparsePresets.save).not.toHaveBeenCalled()
      expect(store.getState().sparsePresetsByRepo['repo-1']).toBeUndefined()
      expect(store.getState().sparsePresetsLoadStatusByRepo['repo-1']).toBe('error')
    } finally {
      consoleError.mockRestore()
    }
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
