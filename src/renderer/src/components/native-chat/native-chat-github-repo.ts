import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { resolveRepoSlug } from '@/lib/repo-slug-index'
import {
  readRepoSlugCache,
  REPO_SLUG_FAILURE_TTL_MS,
  repoSlugCacheKey,
  repoUpstreamIdentityKey
} from '@/lib/repo-slug-cache'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { FILE_LINK_CONTEXT_INPUT_KEYS } from './native-chat-file-link'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, isUnresolvedOwnerHostId } from '../../../../shared/execution-host'
import {
  githubHostFromIdentityKey,
  githubRepoIdentityKey
} from '../../../../shared/github/repository-identity-key'

export type NativeChatGitHubRepo = {
  repo: Repo
  /** Origin then upstream identity keys; main only answers for these remotes. */
  identityKeys: readonly string[]
  /** Where bare `#123` points: upstream unless the repo prefers origin. github.com only. */
  referenceRepo: { owner: string; repo: string } | null
}

function readCachedOriginKey(repo: Repo | null): string | null {
  const cacheKey = repo ? repoSlugCacheKey(repo) : null
  const cached = cacheKey ? readRepoSlugCache(cacheKey) : null
  return cached?.hit ? cached.value : null
}

function ownerRepoFromKey(key: string): { owner: string; repo: string } | null {
  if (githubHostFromIdentityKey(key)) {
    return null
  }
  const [owner, repo] = key.split('/')
  return owner && repo ? { owner, repo } : null
}

type NativeChatRepoState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'floatingWorkspacePath'
> &
  WorktreeRuntimeOwnerState

function resolveNativeChatRepo(
  state: NativeChatRepoState,
  worktreeId: string | undefined
): Repo | null {
  // The same owner the chat's file links route to; twins on other hosts must not answer for it.
  const hostId = worktreeId ? getKnownExecutionHostIdForWorktree(state, worktreeId) : null
  if (!worktreeId || !hostId || isUnresolvedOwnerHostId(hostId)) {
    return null
  }
  const worktree = findKnownWorktreeById(state, worktreeId, hostId)
  if (!worktree) {
    return null
  }
  const owners = state.repos.filter(
    (candidate) => candidate.id === worktree.repoId && getRepoExecutionHostId(candidate) === hostId
  )
  const found = owners.length === 1 ? owners[0] : null
  return found && (!found.kind || found.kind === 'git') ? found : null
}

export function createNativeChatRepoSelector(worktreeId: string | undefined) {
  let inputs: unknown[] | null = null
  let repo: Repo | null = null
  // Retained chats all subscribe; unrelated store writes must not re-resolve the owner or scan repos.
  return (state: NativeChatRepoState): Repo | null => {
    if (!inputs || FILE_LINK_CONTEXT_INPUT_KEYS.some((key, i) => state[key] !== inputs?.[i])) {
      inputs = FILE_LINK_CONTEXT_INPUT_KEYS.map((key) => state[key])
      repo = resolveNativeChatRepo(state, worktreeId)
    }
    return repo
  }
}

/** The git repo behind the chat's workspace, with its GitHub remotes once resolved. */
export function useNativeChatGitHubRepo(
  worktreeId: string | undefined
): NativeChatGitHubRepo | null {
  const selectRepo = useMemo(() => createNativeChatRepoSelector(worktreeId), [worktreeId])
  const repo = useAppStore(selectRepo)
  const [resolved, setResolved] = useState(() => ({
    repo,
    originKey: readCachedOriginKey(repo),
    failed: false
  }))
  const originKey = resolved.repo === repo ? resolved.originKey : readCachedOriginKey(repo)
  const failed = resolved.repo === repo && resolved.failed

  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!repo) {
      return
    }
    let cancelled = false
    void resolveRepoSlug(repo).then((key) => {
      if (!cancelled) {
        setResolved({ repo, originKey: key, failed: !key })
      }
    })
    return () => {
      cancelled = true
    }
  }, [repo, attempt])

  // A failed lookup is cached briefly; ask again once it expires so cards recover.
  useEffect(() => {
    if (!failed) {
      return
    }
    const retry = setTimeout(() => setAttempt((value) => value + 1), REPO_SLUG_FAILURE_TTL_MS)
    return () => clearTimeout(retry)
  }, [failed, attempt])

  return useMemo(() => {
    if (!repo || !originKey) {
      return null
    }
    const upstreamKey = repoUpstreamIdentityKey(repo, originKey)
    const identityKeys =
      upstreamKey && upstreamKey !== originKey ? [originKey, upstreamKey] : [originKey]
    const referenceKey =
      upstreamKey && repo.issueSourcePreference !== 'origin' ? upstreamKey : originKey
    return {
      repo,
      identityKeys,
      referenceRepo: ownerRepoFromKey(referenceKey)
    }
  }, [repo, originKey])
}

export function githubLinkBelongsToRepo(
  repo: NativeChatGitHubRepo,
  slug: { owner: string; repo: string; host?: string }
): boolean {
  return repo.identityKeys.includes(githubRepoIdentityKey(slug))
}
