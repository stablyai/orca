import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { resolveRepoSlug } from '@/lib/workspace/catalog/repo-slug-index'
import {
  readRepoSlugCache,
  REPO_SLUG_FAILURE_TTL_MS,
  repoSlugCacheKey
} from '@/lib/workspace/catalog/repo-slug-cache'
import { getKnownExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import { FILE_LINK_CONTEXT_INPUT_KEYS } from '../actions/native-chat-file-link-context'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  isUnresolvedOwnerHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
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
  /** Another workspace's repo, lent to a chat that has none so its links preview through the API. */
  borrowed?: true
}

function readCachedOriginKey(repo: Repo | null): string | null {
  const cacheKey = repo ? repoSlugCacheKey(repo) : null
  const cached = cacheKey ? readRepoSlugCache(cacheKey) : null
  return cached?.hit ? cached.value : null
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

/** The host a chat's workspace runs on, and the registered repo or folder behind it. */
export type NativeChatOwner = { hostId: ExecutionHostId; repo: Repo | null }

function isGitRepo(repo: Repo): boolean {
  return !repo.kind || repo.kind === 'git'
}

/** Null when the chat has no workspace or its owner is not known yet. */
export function resolveNativeChatOwner(
  state: NativeChatRepoState,
  worktreeId: string | undefined
): NativeChatOwner | null {
  // The same owner the chat's file links route to; twins on other hosts must not answer for it.
  const hostId = worktreeId ? getKnownExecutionHostIdForWorktree(state, worktreeId) : null
  if (!worktreeId || !hostId || isUnresolvedOwnerHostId(hostId)) {
    return null
  }
  const worktree = findKnownWorktreeById(state, worktreeId, hostId)
  if (!worktree) {
    return { hostId, repo: null }
  }
  const owners = state.repos.filter(
    (candidate) => candidate.id === worktree.repoId && getRepoExecutionHostId(candidate) === hostId
  )
  return { hostId, repo: owners.length === 1 ? owners[0] : null }
}

/** Memoized on the inputs file links use, so retained chats skip unrelated store writes. */
export function createNativeChatOwnerSelector(worktreeId: string | undefined) {
  let inputs: unknown[] | null = null
  let owner: NativeChatOwner | null = null
  return (state: NativeChatRepoState): NativeChatOwner | null => {
    if (!inputs || FILE_LINK_CONTEXT_INPUT_KEYS.some((key, i) => state[key] !== inputs?.[i])) {
      inputs = FILE_LINK_CONTEXT_INPUT_KEYS.map((key) => state[key])
      owner = resolveNativeChatOwner(state, worktreeId)
    }
    return owner
  }
}

/** The git repo behind a chat's workspace, or null for a folder or an unknown owner. */
export function createNativeChatRepoSelector(worktreeId: string | undefined) {
  const selectOwner = createNativeChatOwnerSelector(worktreeId)
  return (state: NativeChatRepoState): Repo | null => {
    const repo = selectOwner(state)?.repo
    return repo && isGitRepo(repo) ? repo : null
  }
}

/** The git repo behind the chat's workspace, with its GitHub remotes once resolved. */
function useChatWorkspaceGitHubRepo(worktreeId: string | undefined): NativeChatGitHubRepo | null {
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
    return {
      repo,
      identityKeys,
      referenceRepo: githubReferenceRepo(repo, originKey)
    }
  }, [repo, originKey])
}

const MAX_BORROWED_REPO_CANDIDATES = 8

/** Every registered repo; callers filter by kind and host. */
function selectLocalGitRepos(state: Pick<AppState, 'repos'>): readonly Repo[] {
  return state.repos
}

/** True for a repo on this computer. */
function isLocal(repo: Repo): boolean {
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

/** Git repos on the chat's own host that may lend it GitHub previews, so a remote chat never sends
 *  previews with this computer's sign-in. None when the chat's host is unknown. */
export function borrowableGitHubRepos(
  repos: readonly Repo[],
  ownerHostId: ExecutionHostId | null
): readonly Repo[] {
  if (!ownerHostId) {
    return []
  }
  return repos
    .filter((repo) => isGitRepo(repo) && getRepoExecutionHostId(repo) === ownerHostId)
    .slice(0, MAX_BORROWED_REPO_CANDIDATES)
}

/** A local repo to send GitHub previews through for a chat whose workspace has none (a plain
 *  folder). A github.com git repo is preferred; failing that, the chat's own local folder, which
 *  main lets preview github.com links only. Bare `#123` stays text either way, since no repo owns it. */
function useBorrowedGitHubRepo(
  enabled: boolean,
  owner: NativeChatOwner | null
): NativeChatGitHubRepo | null {
  const repos = useAppStore(selectLocalGitRepos)
  const ownerHostId = owner?.hostId ?? null
  const gitCandidates = useMemo(
    () => (enabled ? borrowableGitHubRepos(repos, ownerHostId) : []),
    [enabled, ownerHostId, repos]
  )
  const ownRepo = owner?.repo ?? null
  const folder = enabled && ownRepo?.kind === 'folder' && isLocal(ownRepo) ? ownRepo : null
  const [borrowed, setBorrowed] = useState<{ repo: Repo; key: string } | null>(null)
  useEffect(() => {
    if (gitCandidates.length === 0) {
      setBorrowed(null)
      return
    }
    let cancelled = false
    void (async () => {
      for (const repo of gitCandidates) {
        const key = await resolveRepoSlug(repo).catch(() => null)
        if (cancelled) {
          return
        }
        // github.com keys carry no host prefix; enterprise hosts would answer for their own links only.
        if (key && !githubHostFromIdentityKey(key)) {
          setBorrowed({ repo, key })
          return
        }
      }
      setBorrowed(null)
    })()
    return () => {
      cancelled = true
    }
  }, [gitCandidates])
  return useMemo(() => {
    if (borrowed) {
      return {
        repo: borrowed.repo,
        identityKeys: [borrowed.key],
        referenceRepo: null,
        borrowed: true
      }
    }
    // No identity keys: the folder has no remotes, and only github.com links resolve against it.
    return folder ? { repo: folder, identityKeys: [], referenceRepo: null, borrowed: true } : null
  }, [borrowed, folder])
}

/** The chat workspace's GitHub repo, or else a borrowed one so GitHub links still preview through the API. */
export function useNativeChatGitHubRepo(
  worktreeId: string | undefined
): NativeChatGitHubRepo | null {
  const own = useChatWorkspaceGitHubRepo(worktreeId)
  const selectOwner = useMemo(() => createNativeChatOwnerSelector(worktreeId), [worktreeId])
  const owner = useAppStore(selectOwner)
  const borrowed = useBorrowedGitHubRepo(own === null, owner)
  return own ?? borrowed
}

/** True when the link points into the chat repo itself (origin or upstream). */
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
  if (repo.borrowed && repo.identityKeys.length === 0) {
    // A borrowed folder previews github.com only, the host whose keys carry no prefix.
    return !host
  }
  return repo.identityKeys.some((key) => githubHostFromIdentityKey(key) === host)
}

/** The chat workspace's git repo, or else a git repo on the same host: GitLab lookups name their
 *  project in the link and need a repo only to pick the host and sign-in that answer. A chat on a
 *  host with no git repo gets null, so its links never borrow another host's sign-in. */
export function selectNativeChatLookupRepo(
  owner: NativeChatOwner | null,
  repos: readonly Repo[]
): Repo | null {
  if (owner?.repo && isGitRepo(owner.repo)) {
    return owner.repo
  }
  const hostId = owner?.hostId ?? LOCAL_EXECUTION_HOST_ID
  return repos.find((repo) => isGitRepo(repo) && getRepoExecutionHostId(repo) === hostId) ?? null
}

/** `selectNativeChatLookupRepo` for a chat, kept current with the store. */
export function useNativeChatLookupRepo(worktreeId: string | undefined): Repo | null {
  const selectOwner = useMemo(() => createNativeChatOwnerSelector(worktreeId), [worktreeId])
  const owner = useAppStore(selectOwner)
  const repos = useAppStore(selectLocalGitRepos)
  return useMemo(() => selectNativeChatLookupRepo(owner, repos), [owner, repos])
}
