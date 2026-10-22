import type { PreloadApi } from '../../../../preload/api-types'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { resolveRuntimeFilePath } from './web-runtime-worktree-catalog'

type GitApi = NonNullable<Partial<PreloadApi>['git']>

/** Per-file reads that resolve a path to its runtime worktree before calling the host. */
export function createGitFileDiffApi(): Pick<
  GitApi,
  'diff' | 'branchDiff' | 'commitDiff' | 'blame'
> {
  return {
    diff: async ({ worktreePath, filePath, staged, compareAgainstHead }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.diff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        staged,
        compareAgainstHead
      })
    },
    branchDiff: async ({ worktreePath, filePath, compare, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.branchDiff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        compare,
        oldPath
      })
    },
    commitDiff: async ({ worktreePath, filePath, commitOid, parentOid, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.commitDiff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        commitOid,
        parentOid,
        oldPath
      })
    },
    blame: async ({ worktreePath, filePath, contents }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.blame', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        contents
      })
    }
  }
}
