import { useAppStore } from '@/store'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getFolderWorkspaceConnectionId } from './folder-workspace-connection'

/**
 * Resolve the SSH connectionId for a worktree. Returns null for local repos,
 * the target ID string for remote repos, or undefined if the worktree/repo
 * cannot be found (e.g., store not yet hydrated).
 */
export function getConnectionId(worktreeId: string | null): string | null | undefined {
  if (!worktreeId) {
    return null
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return getFolderWorkspaceConnectionId(
      useAppStore.getState(),
      parsedWorkspaceKey.folderWorkspaceId
    )
  }
  const state = useAppStore.getState()
  const allWorktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  const worktree = allWorktrees.find((w) => w.id === worktreeId)
  // Why: SSH worktrees can be restored from session IDs before relay discovery
  // repopulates worktreesByRepo. The composite ID still carries the repo ID.
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos?.find((r) => r.id === repoId)
  if (!repo) {
    return undefined
  }
  return repo.connectionId ?? null
}
