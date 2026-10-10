import type { RepoSlug } from '@/lib/github-links'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeTarget
} from '@/lib/github-source-runtime-context'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { RepoOption, RepoSlugTarget } from './smart-workspace-name-field-model'

export function sameSlug(left: RepoSlug, right: RepoSlug): boolean {
  return githubRepoIdentityKey(left) === githubRepoIdentityKey(right)
}

export async function getRepoSlugCached(
  repo: Pick<RepoOption, 'id' | 'path'>,
  sourceContext: TaskSourceContext | null | undefined,
  cache: Map<string, RepoSlug>
): Promise<RepoSlug | null> {
  const cacheKey = sourceContext
    ? `${getTaskSourceCacheScope(sourceContext)}\0${repo.path}`
    : `local:${repo.id}\0${repo.path}`
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null
  }
  try {
    const target = getGitHubSourceRuntimeTarget(sourceContext)
    const slug =
      target.kind === 'environment'
        ? await callRuntimeRpc<RepoSlug | null>(
            target,
            'github.repoSlug',
            { repo: getGitHubRuntimeRepoId(sourceContext, repo.id) },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.repoSlug({ repoPath: repo.path, repoId: repo.id })
    if (slug) {
      cache.set(cacheKey, slug)
    }
    return slug
  } catch {
    return null
  }
}

export async function findMatchingRepoForSlug(
  targets: readonly RepoSlugTarget[],
  slug: RepoSlug,
  cache: Map<string, RepoSlug>
): Promise<RepoSlugTarget | null> {
  for (const target of targets) {
    const candidate = await getRepoSlugCached(target.repo, target.sourceContext, cache)
    if (candidate && sameSlug(candidate, slug)) {
      return target
    }
  }
  return null
}
