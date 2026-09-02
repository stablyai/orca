import type { RepoSlug } from '@/lib/github-links'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeTarget
} from '@/lib/github-source-runtime-context'
import { repoUpstreamIdentityKey } from '@/lib/repo-slug-cache'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { RepoOption, RepoSlugTarget } from './smart-workspace-name-field-model'

type RepoIdentityKind = 'origin' | 'upstream'
type RepoIdentityTarget = Pick<RepoOption, 'id' | 'path' | 'upstream'>

export function sameSlug(left: RepoSlug, right: RepoSlug): boolean {
  return githubRepoIdentityKey(left) === githubRepoIdentityKey(right)
}

function repoIdentityCacheKey(
  repo: Pick<RepoOption, 'id' | 'path'>,
  sourceContext: TaskSourceContext | null | undefined,
  kind: RepoIdentityKind
): string {
  const base = sourceContext
    ? `${getTaskSourceCacheScope(sourceContext)}\0${repo.path}`
    : `local:${repo.id}\0${repo.path}`
  return kind === 'upstream' ? `upstream:${base}` : base
}

async function getRepoIdentityCached(
  repo: Pick<RepoOption, 'id' | 'path'>,
  sourceContext: TaskSourceContext | null | undefined,
  cache: Map<string, RepoSlug>,
  kind: RepoIdentityKind
): Promise<RepoSlug | null> {
  const cacheKey = repoIdentityCacheKey(repo, sourceContext, kind)
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null
  }
  try {
    const target = getGitHubSourceRuntimeTarget(sourceContext)
    const method = kind === 'upstream' ? 'github.repoUpstream' : 'github.repoSlug'
    const slug =
      target.kind === 'environment'
        ? await callRuntimeRpc<RepoSlug | null>(
            target,
            method,
            { repo: getGitHubRuntimeRepoId(sourceContext, repo.id) },
            { timeoutMs: 30_000 }
          )
        : await (kind === 'upstream' ? window.api.gh.repoUpstream : window.api.gh.repoSlug)({
            repoPath: repo.path,
            repoId: repo.id
          })
    if (slug) {
      cache.set(cacheKey, slug)
    }
    return slug
  } catch {
    return null
  }
}

export async function getRepoSlugCached(
  repo: Pick<RepoOption, 'id' | 'path'>,
  sourceContext: TaskSourceContext | null | undefined,
  cache: Map<string, RepoSlug>
): Promise<RepoSlug | null> {
  return getRepoIdentityCached(repo, sourceContext, cache, 'origin')
}

export async function getRepoUpstreamCached(
  repo: Pick<RepoOption, 'id' | 'path'>,
  sourceContext: TaskSourceContext | null | undefined,
  cache: Map<string, RepoSlug>
): Promise<RepoSlug | null> {
  return getRepoIdentityCached(repo, sourceContext, cache, 'upstream')
}

function persistedUpstreamMatchesPasted(
  repo: Pick<RepoOption, 'upstream'>,
  origin: RepoSlug,
  pasted: RepoSlug
): boolean {
  return (
    repoUpstreamIdentityKey(repo, githubRepoIdentityKey(origin)) === githubRepoIdentityKey(pasted)
  )
}

async function repoUpstreamMatchesPastedSlug(
  repo: RepoIdentityTarget,
  origin: RepoSlug,
  pasted: RepoSlug,
  sourceContext: TaskSourceContext | null | undefined,
  cache: Map<string, RepoSlug>
): Promise<boolean> {
  if (persistedUpstreamMatchesPasted(repo, origin, pasted)) {
    return true
  }
  // Why: `null` is a resolved non-fork; only unresolved forks need a live probe.
  if (repo.upstream !== undefined) {
    return false
  }
  const live = await getRepoUpstreamCached(repo, sourceContext, cache)
  return (
    repoUpstreamIdentityKey({ upstream: live }, githubRepoIdentityKey(origin)) ===
    githubRepoIdentityKey(pasted)
  )
}

export async function selectedRepoMatchesPastedSlug(
  repo: RepoIdentityTarget,
  sourceContext: TaskSourceContext | null | undefined,
  cache: Map<string, RepoSlug>,
  pasted: RepoSlug
): Promise<boolean> {
  const origin = await getRepoSlugCached(repo, sourceContext, cache)
  if (!origin || sameSlug(origin, pasted)) {
    return true
  }
  return repoUpstreamMatchesPastedSlug(repo, origin, pasted, sourceContext, cache)
}

export async function findMatchingRepoForSlug(
  targets: readonly RepoSlugTarget[],
  slug: RepoSlug,
  cache: Map<string, RepoSlug>
): Promise<RepoSlugTarget | null> {
  let upstreamMatch: RepoSlugTarget | null = null
  for (const target of targets) {
    const origin = await getRepoSlugCached(target.repo, target.sourceContext, cache)
    if (origin && sameSlug(origin, slug)) {
      return target
    }
    if (
      !upstreamMatch &&
      origin &&
      (await repoUpstreamMatchesPastedSlug(target.repo, origin, slug, target.sourceContext, cache))
    ) {
      upstreamMatch = target
    }
  }
  return upstreamMatch
}
