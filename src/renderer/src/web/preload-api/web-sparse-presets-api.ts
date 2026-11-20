import type { PreloadApi } from '../../../../preload/api-types'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

export function createWebSparsePresetsApi(): NonNullable<Partial<PreloadApi>['sparsePresets']> {
  return {
    list: async ({ repoId }) =>
      (await callRuntimeResult<{ presets: SparsePreset[] }>('repo.sparsePresets', { repo: repoId }))
        .presets,
    save: async ({ repoId, id, name, directories }) =>
      (
        await callRuntimeResult<{ preset: SparsePreset }>('repo.saveSparsePreset', {
          repo: repoId,
          ...(id ? { id } : {}),
          name,
          directories
        })
      ).preset,
    remove: async ({ repoId, presetId }) => {
      await callRuntimeResult('repo.removeSparsePreset', { repo: repoId, presetId })
    },
    onChanged: () => noopUnsubscribe
  }
}
