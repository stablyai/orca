import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { normalizeRuntimePathForComparison } from '../../../../../shared/cross-platform-path'
import { getWorktreeExecutionHostId } from '../../../../../shared/execution-host'
import { findIndexedRepoOwnerForHost } from '@/lib/workspace/ownership/repo-owner-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { gitGraphScope } from '@/lib/source-control/graph/git-graph-tab'
import { getRuntimeGitRefs } from '@/runtime/source-control/git/runtime-git-status-client'

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
  scope: ReturnType<typeof gitGraphScope>,
  refId: string,
  isLive: () => boolean
): Promise<void> {
  const hostId = scope?.route.executionHostId
  if (!scope || !hostId || !isLive()) {
    return
  }
  const worktreeId = scope.worktree.id
  const current = () =>
    isLive() &&
    gitGraphOwnerKey(scope) ===
      gitGraphOwnerKey(gitGraphScope(worktreeId, useAppStore.getState(), hostId))
  try {
    const refs = await getRuntimeGitRefs(
      {
        target: scope.target,
        worktreeId: worktreeId,
        worktreePath: scope.worktree.path,
        connectionId: scope.connectionId ?? undefined
      },
      refId
    )
    if (!current()) {
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
      activateAndRevealWorktree(workspace.id, {
        navigationIntent: 'user-open',
        executionHostId: hostId,
        clearSidebarFilters: false
      })
    } else {
      toast.message(
        translate(
          'gitGraph.workspaceClosed',
          "This branch isn't open in another workspace anymore."
        )
      )
    }
  } catch {
    if (current()) {
      toast.message(
        translate(
          'gitGraph.workspaceCheckFailed',
          "Couldn't check this workspace. Try again when connected."
        )
      )
    }
  }
}
