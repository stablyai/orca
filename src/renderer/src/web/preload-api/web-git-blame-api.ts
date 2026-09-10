import type { PreloadApi } from '../../../../preload/api-types'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { resolveRuntimeFilePath } from './web-runtime-worktree-catalog'

type GitApi = NonNullable<Partial<PreloadApi>['git']>

/**
 * Blame half of the web git API.
 *
 * Why its own module: web-git-api.ts sits against the 300-line ceiling, and these
 * two methods share no helpers with the rest of it beyond path resolution.
 */
export function createGitBlameApi(): Pick<GitApi, 'fileBlame' | 'lineBlame'> {
  return {
    fileBlame: async ({ worktreePath, filePath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.fileBlame', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath
      })
    },
    lineBlame: async ({ worktreePath, filePath, line }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.lineBlame', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        line
      })
    }
  }
}
