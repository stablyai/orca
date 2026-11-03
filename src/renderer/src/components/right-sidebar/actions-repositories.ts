import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import { findFolderWorkspaceCandidateRepos } from '../../../../shared/folder-workspace-execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

/** Find registered Git repositories for worktree or folder scope, deduplicated by execution host and path. */
export function actionsCandidateRepos(state: AppState, workspaceId: string | null): Repo[] {
  if (!workspaceId) {
    return []
  }
  const scope = parseWorkspaceKey(workspaceId)
  const worktree = state.getKnownWorktreeById(workspaceId)
  const repo = state.repos.find((entry) => entry.id === worktree?.repoId)
  const candidates =
    scope?.type === 'folder'
      ? findFolderWorkspaceCandidateRepos(state, scope.folderWorkspaceId)
      : repo
        ? [repo]
        : []
  const keys = new Set<string>()
  return candidates.filter((entry) => {
    const key = `${getRepoExecutionHostId(entry)}:${entry.path}`
    if (isFolderRepo(entry) || keys.has(key)) {
      return false
    }
    keys.add(key)
    return true
  })
}
export { actionsRepoProbeKey } from '@/store/github/actions-request-identity'
