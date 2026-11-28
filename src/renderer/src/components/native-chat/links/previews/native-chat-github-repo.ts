import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { resolveRepoSlug } from '@/lib/workspace/catalog/repo-slug-index'
import {
  readRepoSlugCache,
  REPO_SLUG_FAILURE_TTL_MS,
  repoSlugCacheKey
} from '@/lib/workspace/catalog/repo-slug-cache'
import { FILE_LINK_CONTEXT_INPUT_KEYS } from '../actions/native-chat-file-link-context'
import {
  resolveWorktreeOwnerRepo,
  type WorktreeOwnerRepoState
} from '@/lib/workspace/ownership/worktree-owner-repo'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  githubHostFromIdentityKey,
  githubRepoIdentityKey,
  repoUpstreamIdentityKey
} from '../../../../../../shared/github/repositories/repository-identity-key'
import {
  githubReferenceRepo,
  type GitHubRepoReference
} from '../../../../../../shared/github/markdown/github-reference-links'

export type NativeChatGitHubRepo = {
  repo: Repo
  /** Origin then upstream identity keys; main answers previews for any repo on their hosts. */
  identityKeys: readonly string[]
  /** Where bare `#123` points: upstream unless the repo prefers origin. github.com only. */
  referenceRepo: GitHubRepoReference | null
}

function readCachedOriginKey(repo: Repo | null): string | null {
  const cacheKey = repo ? repoSlugCacheKey(repo) : null
  const cached = cacheKey ? readRepoSlugCache(cacheKey) : null
  return cached?.hit ? cached.value : null
}

/** `hostId` pins the workspace's host when the caller knows it, over the active selection's twin. */
export function createNativeChatRepoSelector(
  worktreeId: string | undefined,
  hostId?: ExecutionHostId
) {
  let inputs: unknown[] | null = null
  let repo: Repo | null = null
  // Retained chats all subscribe; unrelated store writes must not re-resolve the owner or scan repos.
  return (state: WorktreeOwnerRepoState): Repo | null => {
    if (!inputs || FILE_LINK_CONTEXT_INPUT_KEYS.some((key, i) => state[key] !== inputs?.[i])) {
      inputs = FILE_LINK_CONTEXT_INPUT_KEYS.map((key) => state[key])
      repo = resolveWorktreeOwnerRepo(state, worktreeId, hostId)
    }
    return repo
  }
}

/** The git repo behind the chat's workspace, with its GitHub remotes once resolved. */
export function useNativeChatGitHubRepo(
  worktreeId: string | undefined,
  hostId?: ExecutionHostId
): NativeChatGitHubRepo | null {
  const selectRepo = useMemo(
    () => createNativeChatRepoSelector(worktreeId, hostId),
    [worktreeId, hostId]
  )
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
    return {
      repo,
      identityKeys,
      referenceRepo: githubReferenceRepo(repo, originKey)
    }
  }, [repo, originKey])
}

export function githubLinkBelongsToRepo(
  repo: NativeChatGitHubRepo,
  slug: { owner: string; repo: string; host?: string }
): boolean {
  return repo.identityKeys.includes(githubRepoIdentityKey(slug))
}

/** A link to any repo on a host the chat repo's remotes use, which main answers previews for. */
export function githubLinkOnRepoHost(
  repo: NativeChatGitHubRepo,
  slug: { owner: string; repo: string; host?: string }
): boolean {
  const host = githubHostFromIdentityKey(githubRepoIdentityKey(slug))
  return repo.identityKeys.some((key) => githubHostFromIdentityKey(key) === host)
}
