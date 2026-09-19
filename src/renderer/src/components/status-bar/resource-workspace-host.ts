import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'
import type { MergeContext } from './resource-usage-merge-types'

/** Folder catalog row for host/name attribution; a duplicated id cannot choose a host, so it yields nothing. */
export function resolveResourceFolderWorkspace(
  ctx: MergeContext,
  worktreeId: string
): Worktree | undefined {
  if (
    parseWorkspaceKey(worktreeId)?.type !== 'folder' ||
    ctx.ambiguousWorktreeIds?.has(worktreeId)
  ) {
    return undefined
  }
  return ctx.worktreeById?.get(worktreeId)
}

export function resolveResourceWorkspaceHost(
  ctx: MergeContext,
  worktreeId: string,
  repoId: string
): { isRemote: boolean; isRuntimeScoped: boolean } {
  const folder = resolveResourceFolderWorkspace(ctx, worktreeId)
  const host = folder ? parseExecutionHostId(folder.hostId ?? 'local') : null
  return {
    // Folder siblings may execute on different hosts within the same project group.
    isRemote: host ? host.kind === 'ssh' : ctx.repoConnectionIdById.get(repoId) != null,
    isRuntimeScoped: host ? host.kind === 'runtime' : ctx.repoRuntimeScopedById.get(repoId) === true
  }
}
