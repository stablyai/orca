import type { RepoSlug } from '../../../../../shared/github/repositories/links'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeTarget
} from '@/lib/work-items/github/github-source-runtime-context'
import { githubRepoIdentityKey } from '../../../../../shared/github/repositories/repository-identity-key'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'
import type { RepoOption, RepoSlugTarget } from '../name-field/smart-workspace-name-field-model'

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
