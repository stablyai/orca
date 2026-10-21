import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'

/** Where a notebook's kernel would run: kernels exist only on this computer. */
export type NotebookExecutionHost = 'local' | 'remote' | 'unresolved'

/**
 * Why: a managed SSH or paired-server workspace has no SSH connection id, so "no connection id"
 * cannot mean local; running its cells here would execute a same-named local file.
 */
export function resolveNotebookExecutionHost(
  state: WorktreeOperationRouteState,
  worktreeId: string
): NotebookExecutionHost {
  const match = resolveOwner(state, { workspaceId: worktreeId })
  if (match.kind !== 'resolved') {
    return 'unresolved'
  }
  const { owner } = match
  return owner.endpoint.kind === 'self' && owner.at === LOCAL_EXECUTION_HOST_ID ? 'local' : 'remote'
}
