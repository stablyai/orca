import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import {
  resolveRuntimeFilePath,
  resolveRuntimeWorktreeByPath
} from './web-runtime-worktree-catalog'

// The runtime route cannot target a submodule yet; running on the parent repository would be wrong.
export function refuseSubmoduleAction(submodulePath: string | undefined): void {
  if (submodulePath !== undefined) {
    throw new Error('Submodule actions are not available on this host yet')
  }
}

/** The parent worktree for a runtime call, refused outright when a submodule was named. */
export async function resolveRuntimeWorktreeUnlessSubmodule(
  worktreePath: string,
  submodulePath: string | undefined
): ReturnType<typeof resolveRuntimeWorktreeByPath> {
  refuseSubmoduleAction(submodulePath)
  return resolveRuntimeWorktreeByPath(worktreePath)
}

export async function mutateGitPath(
  method: string,
  worktreePath: string,
  filePath: string,
  submodulePath?: string
): Promise<void> {
  refuseSubmoduleAction(submodulePath)
  const file = await resolveRuntimeFilePath(filePath, worktreePath)
  await callRuntimeResult(method, {
    worktree: toRuntimeWorktreeSelector(file.worktree.id),
    filePath: file.relativePath
  })
}

export async function mutateGitPaths(
  method: string,
  worktreePath: string,
  filePaths: string[],
  submodulePath?: string
): Promise<void> {
  refuseSubmoduleAction(submodulePath)
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  await callRuntimeResult(method, { worktree: toRuntimeWorktreeSelector(worktree.id), filePaths })
}
