import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { SparsePreset } from '../../../../shared/types'

const ERROR_TOAST_DURATION = 60_000

export type SparsePresetsSlice = {
  /** Per-repo preset list. Lazily populated by `fetchSparsePresets`; missing
   *  key means "not yet fetched", empty array means "fetched, none exist". */
  sparsePresetsByRepo: Record<string, SparsePreset[]>
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

  fetchSparsePresets: async (repoId) => {
    try {
      const presets = await window.api.sparsePresets.list({ repoId })
      set((s) => ({
        sparsePresetsByRepo: { ...s.sparsePresetsByRepo, [repoId]: presets }
      }))
    } catch (err) {
      console.error(`Failed to fetch sparse presets for repo ${repoId}:`, err)
    }
  },

  saveSparsePreset: async (args) => {
    try {
      const saved = await window.api.sparsePresets.save(args)
      set((s) => {
        const existing = s.sparsePresetsByRepo[args.repoId] ?? []
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
