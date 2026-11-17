import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../../../types'
import type { SparsePreset } from '../../../../../../shared/worktree/create-types'
import { translate } from '@/i18n/i18n'
import type { SparsePresetFailure } from '../../../../../../shared/worktree/creation/sparse-preset-failure'

const ERROR_TOAST_DURATION = 60_000

function sparsePresetFailureMessage(failure: SparsePresetFailure): string {
  switch (failure.errorCode) {
    case 'name_required':
      return translate('sparsePreset.nameRequired', 'Name is required.')
    case 'name_too_long':
      return translate('sparsePreset.nameTooLong', 'Name must be 80 characters or fewer.')
    case 'directories_required':
      return translate('auto.lib.sparse.preset.draft.efc05d1820', 'Add at least one directory.')
    case 'directories_invalid':
      return translate(
        'auto.lib.sparse.preset.draft.5915a0a1f6',
        'Use repo-relative directories, not root, absolute paths, or parent segments.'
      )
    default:
      return failure.error
  }
}

export type SparsePresetsLoadStatus = 'idle' | 'loading' | 'loaded' | 'error'

export type SparsePresetsSlice = {
  /** Missing means unfetched; [] means fetched with no presets. */
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

type SparsePresetsMaps = Pick<
  AppState,
  | 'sparsePresetsByRepo'
  | 'sparsePresetsLoadingByRepo'
  | 'sparsePresetsLoadStatusByRepo'
  | 'sparsePresetsErrorByRepo'
>

// Repo removal prunes all four lazy preset maps; return only changed maps to preserve unrelated selectors.
export function omitSparsePresetsForRepos(
  s: SparsePresetsMaps,
  removedRepoIds: Iterable<string>
): Partial<AppState> {
  const removed = removedRepoIds instanceof Set ? removedRepoIds : new Set(removedRepoIds)
  if (removed.size === 0) {
    return {}
  }
  const omit = <T>(obj: Record<string, T>): Record<string, T> => {
    let changed = false
    const out = { ...obj }
    for (const id of removed) {
      if (id in out) {
        delete out[id]
        changed = true
      }
    }
    return changed ? out : obj
  }
  const result: Partial<AppState> = {}
  const byRepo = omit(s.sparsePresetsByRepo)
  if (byRepo !== s.sparsePresetsByRepo) {
    result.sparsePresetsByRepo = byRepo
  }
  const loading = omit(s.sparsePresetsLoadingByRepo)
  if (loading !== s.sparsePresetsLoadingByRepo) {
    result.sparsePresetsLoadingByRepo = loading
  }
  const status = omit(s.sparsePresetsLoadStatusByRepo)
  if (status !== s.sparsePresetsLoadStatusByRepo) {
    result.sparsePresetsLoadStatusByRepo = status
  }
  const error = omit(s.sparsePresetsErrorByRepo)
  if (error !== s.sparsePresetsErrorByRepo) {
    result.sparsePresetsErrorByRepo = error
  }
  return result
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
          toast.error(
            args.id
              ? translate('auto.store.slices.sparse.presets.811be06b57', 'Failed to update preset')
              : translate('auto.store.slices.sparse.presets.c96b770172', 'Failed to save preset'),
            {
              description: translate(
                'auto.store.slices.sparse.presets.ef13e994e6',
                'Presets must load before saving.'
              ),
              duration: ERROR_TOAST_DURATION
            }
          )
          return null
        }
      }
      const saved = await window.api.sparsePresets.save(args)
      if ('errorCode' in saved) {
        throw new Error(sparsePresetFailureMessage(saved))
      }
      set((s) => {
        const existing = s.sparsePresetsByRepo[args.repoId]
        if (existing === undefined) {
          return s
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
      toast.success(
        args.id
          ? translate('auto.store.slices.sparse.presets.e10f097822', 'Preset updated')
          : translate('auto.store.slices.sparse.presets.0696d13e56', 'Preset saved'),
        { description: saved.name }
      )
      return saved
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(
        args.id
          ? translate('auto.store.slices.sparse.presets.811be06b57', 'Failed to update preset')
          : translate('auto.store.slices.sparse.presets.c96b770172', 'Failed to save preset'),
        {
          description: message,
          duration: ERROR_TOAST_DURATION
        }
      )
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
      toast.success(translate('auto.store.slices.sparse.presets.ee434d7941', 'Preset removed'))
    } catch (err) {
      set((s) => ({
        sparsePresetsByRepo: { ...s.sparsePresetsByRepo, [repoId]: previous }
      }))
      const message = err instanceof Error ? err.message : String(err)
      toast.error(
        translate('auto.store.slices.sparse.presets.6ed7d6010a', 'Failed to remove preset'),
        {
          description: message,
          duration: ERROR_TOAST_DURATION
        }
      )
      // Why: settings UI keeps confirmation/edit state until persistence succeeds.
      throw err
    }
  }
})
