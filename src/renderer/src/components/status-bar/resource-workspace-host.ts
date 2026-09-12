import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { MergeContext } from './resource-usage-merge-types'

export function resolveResourceWorkspaceHost(
  ctx: MergeContext,
  worktreeId: string,
  repoId: string
): { isRemote: boolean; isRuntimeScoped: boolean } {
  const folder =
    parseWorkspaceKey(worktreeId)?.type === 'folder' ? ctx.worktreeById?.get(worktreeId) : undefined
  const host = folder ? parseExecutionHostId(folder.hostId ?? 'local') : null
  return {
    // Folder siblings may execute on different hosts within the same project group.
    isRemote: host ? host.kind === 'ssh' : ctx.repoConnectionIdById.get(repoId) != null,
    isRuntimeScoped: host ? host.kind === 'runtime' : ctx.repoRuntimeScopedById.get(repoId) === true
  }
}
