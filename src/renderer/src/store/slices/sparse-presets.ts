import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { SparsePreset } from '../../../../shared/types'

const ERROR_TOAST_DURATION = 60_000

export type SparsePresetsLoadStatus = 'idle' | 'loading' | 'loaded' | 'error'

export type SparsePresetsSlice = {
  /** Per-repo preset list. Lazily populated by `fetchSparsePresets`; missing
   *  key means "not yet fetched", empty array means "fetched, none exist". */
  sparsePresetsByRepo: Record<string, SparsePreset[]>
  /** Per-repo fetch guard so missing preset buckets keep their loading meaning. */
  sparsePresetsLoadingByRepo: Record<string, boolean>
  sparsePresetsLoadStatusByRepo: Record<string, SparsePresetsLoadStatus>
  sparsePresetsErrorByRepo: Record<string, string | undefined>
  fetchSparsePresets: (repoId: string) => Promise<void>
  saveSparsePreset: (args: {
    repoId: string
    id?: string
    name: string
    directories: string[]
  }) => Promise<SparsePreset | null>
  removeSparsePreset: (args: { repoId: string; presetId: string }) => Promise<void>
}

export const createSparsePresetsSlice: StateCreator<AppState, [], [], SparsePresetsSlice> = (
  set,
  get
) => ({
  sparsePresetsByRepo: {},
  sparsePresetsLoadingByRepo: {},
  sparsePresetsLoadStatusByRepo: {},
  sparsePresetsErrorByRepo: {},

  fetchSparsePresets: async (repoId) => {
    const state = get()
    if (
      state.sparsePresetsByRepo[repoId] !== undefined ||
      state.sparsePresetsLoadingByRepo[repoId]
    ) {
      return
    }
    set((s) => ({
      sparsePresetsLoadingByRepo: { ...s.sparsePresetsLoadingByRepo, [repoId]: true },
      sparsePresetsLoadStatusByRepo: { ...s.sparsePresetsLoadStatusByRepo, [repoId]: 'loading' },
      sparsePresetsErrorByRepo: { ...s.sparsePresetsErrorByRepo, [repoId]: undefined }
    }))
    try {
      const presets = await window.api.sparsePresets.list({ repoId })
      set((s) => ({
        sparsePresetsByRepo: { ...s.sparsePresetsByRepo, [repoId]: presets },
        sparsePresetsLoadingByRepo: { ...s.sparsePresetsLoadingByRepo, [repoId]: false },
        sparsePresetsLoadStatusByRepo: { ...s.sparsePresetsLoadStatusByRepo, [repoId]: 'loaded' },
        sparsePresetsErrorByRepo: { ...s.sparsePresetsErrorByRepo, [repoId]: undefined }
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((s) => ({
        sparsePresetsLoadingByRepo: { ...s.sparsePresetsLoadingByRepo, [repoId]: false },
        sparsePresetsLoadStatusByRepo: { ...s.sparsePresetsLoadStatusByRepo, [repoId]: 'error' },
        sparsePresetsErrorByRepo: { ...s.sparsePresetsErrorByRepo, [repoId]: message }
      }))
      console.error(`Failed to fetch sparse presets for repo ${repoId}:`, err)
    }
  },

  saveSparsePreset: async (args) => {
    try {
      if (get().sparsePresetsByRepo[args.repoId] === undefined) {
        // Why: a saved preset alone is not an authoritative repo bucket; load
        // existing presets first so we do not hide them behind a one-item cache.
        await get().fetchSparsePresets(args.repoId)
        if (get().sparsePresetsByRepo[args.repoId] === undefined) {
          toast.error(args.id ? 'Failed to update preset' : 'Failed to save preset', {
            description: 'Presets must load before saving.',
            duration: ERROR_TOAST_DURATION
          })
          return null
        }
      }
      const saved = await window.api.sparsePresets.save(args)
      set((s) => {
        const existing = s.sparsePresetsByRepo[args.repoId]
        if (existing === undefined) {
          return {}
        }
        const without = existing.filter((preset) => preset.id !== saved.id)
        return {
          sparsePresetsByRepo: {
            ...s.sparsePresetsByRepo,
            [args.repoId]: [...without, saved].sort((left, right) =>
              left.name.localeCompare(right.name)
            )
          }
        }
      })
      toast.success(args.id ? 'Preset updated' : 'Preset saved', { description: saved.name })
      return saved
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(args.id ? 'Failed to update preset' : 'Failed to save preset', {
        description: message,
        duration: ERROR_TOAST_DURATION
      })
      return null
    }
  },

  removeSparsePreset: async ({ repoId, presetId }) => {
    const previous = get().sparsePresetsByRepo[repoId] ?? []
    // Why: optimistic local update keeps the popover responsive — toast handles
    // the failure path by restoring state.
    set((s) => ({
      sparsePresetsByRepo: {
        ...s.sparsePresetsByRepo,
        [repoId]: previous.filter((preset) => preset.id !== presetId)
      }
    }))
    try {
      await window.api.sparsePresets.remove({ repoId, presetId })
      toast.success('Preset removed')
    } catch (err) {
      set((s) => ({
        sparsePresetsByRepo: { ...s.sparsePresetsByRepo, [repoId]: previous }
      }))
      const message = err instanceof Error ? err.message : String(err)
      toast.error('Failed to remove preset', {
        description: message,
        duration: ERROR_TOAST_DURATION
      })
    }
  }
})
