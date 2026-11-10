import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../shared/constants'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { repoRowOwnerStamp } from './workspace-terminal-ssh-placeholders'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

export function getPathDisplayName(path: string, fallback: string): string {
  const normalized = path.trim().replace(/[\\/]+$/g, '')
  const basename = normalized.split(/[\\/]/).findLast(Boolean)?.trim()
  return basename || fallback
}

function runtimePlaceholderOwner(
  repos: readonly Repo[],
  repoId: string,
  hostId: ExecutionHostId
): Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'> {
  const row = repos.find((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
  return row ? repoRowOwnerStamp(row) : { hostId }
}

/** Determine whether a worktree belongs to the specified runtime execution host. */
function worktreeBelongsToRuntimeHost(worktree: Worktree, hostId: ExecutionHostId): boolean {
  if (worktree.hostId === hostId) {
    return true
  }
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' && worktree.runtimeOwnerEnvironmentId === parsed.environmentId
}

/** Synthesize placeholder repos and worktrees for offline runtime sessions, deduplicating repos sharing the same host and path. */
export function buildRuntimeSessionPlaceholders({
  repos,
  runtimeHostIdByWorkspaceSessionKey,
  worktreesByRepo
}: {
  repos: readonly Repo[]
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
  worktreesByRepo: Record<string, Worktree[]>
}): {
  repos: readonly Repo[]
  worktreesByRepo: Record<string, Worktree[]>
} {
  // Hydration writes these directly; copy only on change to avoid rerendering every whole-array/map selector.
  let nextRepos: readonly Repo[] = repos
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
    // Strip ::workspace:<uuid> so Git receives a real cwd.
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (!parsed) {
      continue
    }
    const existingRepo =
      nextRepos.find((repo) => repo.id === parsed.repoId) ??
      nextRepos.find(
        (repo) =>
          getRepoExecutionHostId(repo) === hostId &&
          normalizeRuntimePathForComparison(repo.path) ===
            normalizeRuntimePathForComparison(parsed.worktreePath)
      )
    const targetRepoId = existingRepo ? existingRepo.id : parsed.repoId
    if (!existingRepo) {
      // Why: remote catalogs load after hydration but host-split session writes need owner metadata; skip if the repo id already exists to avoid duplicates.
      nextRepos = [
        ...nextRepos,
        {
          id: targetRepoId,
          path: parsed.worktreePath,
          displayName: getPathDisplayName(parsed.worktreePath, targetRepoId),
          badgeColor: DEFAULT_REPO_BADGE_COLOR,
          addedAt: 0,
          connectionId: null,
          executionHostId: hostId
        }
      ]
    }
    if (parsed.repoId !== targetRepoId && nextWorktreesByRepo[parsed.repoId]) {
      nextWorktreesByRepo =
        nextWorktreesByRepo === worktreesByRepo ? { ...worktreesByRepo } : nextWorktreesByRepo
      const previous = nextWorktreesByRepo[parsed.repoId]
      const strandedForHost: Worktree[] = []
      const keptOtherHosts: Worktree[] = []
      for (const wt of previous) {
        if (worktreeBelongsToRuntimeHost(wt, hostId)) {
          strandedForHost.push(wt)
        } else {
          keptOtherHosts.push(wt)
        }
      }
      if (keptOtherHosts.length > 0) {
        nextWorktreesByRepo[parsed.repoId] = keptOtherHosts
      } else {
        delete nextWorktreesByRepo[parsed.repoId]
      }
      if (strandedForHost.length > 0) {
        const merged = [...(nextWorktreesByRepo[targetRepoId] ?? [])]
        const existingInTarget = new Set(merged.map((w) => w.id))
        for (const wt of strandedForHost) {
          if (!existingInTarget.has(wt.id)) {
            merged.push({ ...wt, repoId: targetRepoId })
            existingInTarget.add(wt.id)
          }
        }
        if (merged.length !== (nextWorktreesByRepo[targetRepoId]?.length ?? 0)) {
          nextWorktreesByRepo[targetRepoId] = merged
        }
      }
    }
    const current = nextWorktreesByRepo[targetRepoId] ?? []
    if (!current.some((worktree) => worktree.id === worktreeId)) {
      const placeholder: Worktree = {
        id: worktreeId,
        repoId: targetRepoId,
        ...runtimePlaceholderOwner(nextRepos, targetRepoId, hostId),
        displayName: getPathDisplayName(parsed.worktreePath, targetRepoId),
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
      nextWorktreesByRepo[targetRepoId] = [...current, placeholder]
    }
  }
  return { repos: nextRepos, worktreesByRepo: nextWorktreesByRepo }
}
