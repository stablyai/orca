import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

type RuntimeWorktree = Awaited<ReturnType<typeof resolveRuntimeWorktreeByPath>>

// The runtime route cannot target a submodule yet; running on the parent repository would be wrong.
export function resolveWorktreeForParentAction(
  worktreePath: string,
  submodulePath: string | undefined
): Promise<RuntimeWorktree> {
  if (submodulePath !== undefined) {
    throw new Error('Submodule actions are not available on this host yet')
  }
  return resolveRuntimeWorktreeByPath(worktreePath)
}
