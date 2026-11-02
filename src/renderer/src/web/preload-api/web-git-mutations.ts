import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import type { ConflictResolution } from '../../../../shared/source-control-entry-actions'
import { callRuntimeResult } from './web-runtime-calls'
import {
  resolveRuntimeFilePath,
  resolveRuntimeWorktreeByPath
} from './web-runtime-worktree-catalog'

export async function mutateGitPath(
  method: string,
  worktreePath: string,
  filePath: string
): Promise<void> {
  const file = await resolveRuntimeFilePath(filePath, worktreePath)
  await callRuntimeResult(method, {
    worktree: toRuntimeWorktreeSelector(file.worktree.id),
    filePath: file.relativePath
  })
}

export async function mutateGitPaths(
  method: string,
  worktreePath: string,
  filePaths: string[]
): Promise<void> {
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  await callRuntimeResult(method, { worktree: toRuntimeWorktreeSelector(worktree.id), filePaths })
}

export async function resolveGitConflict(
  worktreePath: string,
  filePath: string,
  resolution: ConflictResolution
): Promise<void> {
  const file = await resolveRuntimeFilePath(filePath, worktreePath)
  await callRuntimeResult('git.resolveConflict', {
    worktree: toRuntimeWorktreeSelector(file.worktree.id),
    filePath: file.relativePath,
    resolution
  })
}
