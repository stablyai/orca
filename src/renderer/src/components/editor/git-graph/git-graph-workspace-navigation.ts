import { normalizeRuntimePathForComparison } from '../../../../../shared/cross-platform-path'
import { getWorktreeExecutionHostId } from '../../../../../shared/execution-host'
import { findIndexedRepoOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { useAppStore } from '@/store'
import { gitGraphScope } from '@/lib/git-graph-tab'
import { getRuntimeGitRefs } from '@/runtime/runtime-git-status-client'
import { getConnectionId } from '@/lib/connection-context'

export const gitGraphOwnerKey = (scope: ReturnType<typeof gitGraphScope>) =>
  JSON.stringify([scope?.route, scope?.worktree.path])
export function gitGraphWorkspaceCatalog(
  scope: ReturnType<typeof gitGraphScope>,
  state: Pick<
    ReturnType<typeof useAppStore.getState>,
    'repos' | 'worktreesByRepo'
  > = useAppStore.getState()
) {
  if (!scope?.route.executionHostId) {
    return []
  }
  const repo = findIndexedRepoOwnerForHost(
    state.repos,
    scope.worktree.repoId,
    scope.route.executionHostId
  )
  return (selectWorktreesByRepo(state)[scope.worktree.repoId] ?? []).filter(
    (row) =>
      row.id !== scope.worktree.id &&
      getWorktreeExecutionHostId(row, repo ?? undefined) === scope.route.executionHostId
  )
}

export async function switchGitGraphWorkspace(
  worktreeId: string,
  refId: string,
  isLive: () => boolean
): Promise<void> {
  const scope = gitGraphScope(worktreeId)
  const hostId = scope?.route.executionHostId
  if (!scope || !hostId || !isLive()) {
    return
  }
  try {
    const refs = await getRuntimeGitRefs(
      {
        target: scope.target,
        worktreeId: worktreeId,
        worktreePath: scope.worktree.path,
        connectionId: getConnectionId(worktreeId) ?? undefined
      },
      refId
    )
    if (!isLive() || gitGraphOwnerKey(scope) !== gitGraphOwnerKey(gitGraphScope(worktreeId))) {
      return
    }
    const path = refs.find((ref) => ref.id === refId)?.worktreePath
    const workspace =
      path &&
      gitGraphWorkspaceCatalog(scope).find(
        (row) =>
          normalizeRuntimePathForComparison(row.path) === normalizeRuntimePathForComparison(path)
      )
    if (workspace) {
      useAppStore.getState().setActiveWorktree(workspace.id, hostId)
    }
  } catch {
    /* A failed lookup cannot navigate to a stale checkout. */
  }
}
