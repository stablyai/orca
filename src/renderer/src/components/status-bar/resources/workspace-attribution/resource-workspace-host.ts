import {
  canonicalExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { MergeContext } from './resource-usage-merge-types'

/** Folder catalog row for host/name attribution; a duplicated id cannot choose a host, so it yields nothing. */
type WorkspaceHostContext = Pick<
  MergeContext,
  'worktreeById' | 'ambiguousWorktreeIds' | 'repoConnectionIdById' | 'repoRuntimeHostIdById'
>

export function resolveResourceFolderWorkspace(
  ctx: Pick<MergeContext, 'worktreeById' | 'ambiguousWorktreeIds'>,
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
  ctx: WorkspaceHostContext,
  worktreeId: string,
  repoId: string
): { isRemote: boolean; runtimeHostId: string | null } {
  const folder = resolveResourceFolderWorkspace(ctx, worktreeId)
  const host = folder ? parseExecutionHostId(folder.hostId ?? 'local') : null
  return {
    // Folder siblings may execute on different hosts within the same project group.
    isRemote: host ? host.kind === 'ssh' : ctx.repoConnectionIdById.get(repoId) != null,
    runtimeHostId: host
      ? host.kind === 'runtime'
        ? host.id
        : null
      : (ctx.repoRuntimeHostIdById.get(repoId) ?? null)
  }
}

/** The paired host a worktree's own record names, which outranks where its repo is tracked. */
export function stampedRuntimeHostId(
  ctx: Pick<MergeContext, 'worktreeById' | 'ambiguousWorktreeIds'>,
  worktreeId: string
): string | null {
  if (ctx.ambiguousWorktreeIds?.has(worktreeId)) {
    return null
  }
  const hostId = canonicalExecutionHostId(ctx.worktreeById?.get(worktreeId)?.hostId)
  return hostId?.startsWith('runtime:') ? hostId : null
}
