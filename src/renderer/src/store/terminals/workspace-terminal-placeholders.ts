import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'

export function getPathDisplayName(path: string, fallback: string): string {
  const normalized = path.trim().replace(/[\\/]+$/g, '')
  const basename = normalized.split(/[\\/]/).findLast(Boolean)?.trim()
  return basename || fallback
}

export function buildRuntimeSessionPlaceholders({
  repos,
  runtimeHostIdByWorkspaceSessionKey,
  worktreesByRepo
}: {
  repos: readonly Repo[]
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
  worktreesByRepo: Record<string, Worktree[]>
}): {
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
} {
  let nextRepos = repos.slice()
  let nextWorktreesByRepo = worktreesByRepo
  for (const workspaceSessionKey of Object.keys(runtimeHostIdByWorkspaceSessionKey)) {
    const hostId = runtimeHostIdByWorkspaceSessionKey[workspaceSessionKey]
    if (parseExecutionHostId(hostId)?.kind !== 'runtime') {
      continue
    }
    const workspaceScope = parseWorkspaceKey(workspaceSessionKey)
    if (workspaceScope?.type === 'folder') {
      continue
    }
    const worktreeId =
      workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : workspaceSessionKey
    // Why: strip the synthetic `::workspace:<uuid>` suffix so path is the real folder — Git callers must not spawn against a nonexistent cwd.
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (!parsed) {
      continue
    }
    const existingRepo = nextRepos.some((repo) => repo.id === parsed.repoId)
    if (!existingRepo) {
      // Why: remote catalogs load after hydration but host-split session writes need owner metadata; skip if the repo id already exists to avoid duplicates.
      nextRepos = [
        ...nextRepos,
        {
          id: parsed.repoId,
          path: parsed.worktreePath,
          displayName: getPathDisplayName(parsed.worktreePath, parsed.repoId),
          badgeColor: DEFAULT_REPO_BADGE_COLOR,
          addedAt: 0,
          connectionId: null,
          executionHostId: hostId
        }
      ]
    }
    const current = nextWorktreesByRepo[parsed.repoId] ?? []
    if (current.some((worktree) => worktree.id === worktreeId)) {
      continue
    }
    const placeholder: Worktree = {
      id: worktreeId,
      repoId: parsed.repoId,
      hostId,
      displayName: getPathDisplayName(parsed.worktreePath, parsed.repoId),
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      path: parsed.worktreePath,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: false
    }
    nextWorktreesByRepo =
      nextWorktreesByRepo === worktreesByRepo ? { ...worktreesByRepo } : nextWorktreesByRepo
    nextWorktreesByRepo[parsed.repoId] = [...current, placeholder]
  }
  return { repos: nextRepos, worktreesByRepo: nextWorktreesByRepo }
}
