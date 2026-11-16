import { useGitHubOperationOwner } from './useGitHubOperationScope'
import { useMemo } from 'react'
import { gitHubSlugApiForTarget } from '@/runtime/repository-github/github-slug-owner-api'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { GitHubAssignableUser } from '../../../shared/github/pull-requests/pull-request-types'
import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'
import { getGitHubGitExecutionRepo } from '@/lib/work-items/github/github-source-runtime-context'
import { clearMetadataRequestStore, createMetadataRequestStore } from './metadata-request-cache'
import { githubRepoIdentityKey } from '../../../shared/github/repositories/repository-identity-key'
import { githubProjectHost } from '../../../shared/github/projects/project-identity'
import { useMetadataListRequest, type MetadataListState } from './useMetadataListRequest'

const slugLabelStore = createMetadataRequestStore<string[]>()
const slugAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export type GitHubSlugMetadataContext = {
  repoId?: string | null
  repoPath?: string | null
  sourceContext?: TaskSourceContext | null
}

export function clearGitHubSlugMetadataCache(): void {
  clearMetadataRequestStore(slugLabelStore)
  clearMetadataRequestStore(slugAssigneeStore)
}

export function useRepoLabelsBySlug(
  owner: string | null,
  repo: string | null,
  ownerTarget?: RuntimeClientTarget | null,
  host?: string,
  context?: GitHubSlugMetadataContext
): MetadataListState<string> {
  const target: RuntimeClientTarget = ownerTarget ?? { kind: 'local' }
  const authority = useGitHubOperationOwner({ ...context, target }).scope
  const gitExecutionRepo = getGitHubGitExecutionRepo(
    context?.sourceContext,
    context?.repoId,
    context?.repoPath
  )
  const selectedOwner = owner ?? ''
  const selectedRepo = repo ?? ''
  const repositoryKey =
    owner && repo ? `${githubRepoIdentityKey({ owner, repo, host })}::${authority}` : null
  const cacheKey =
    repositoryKey && target.kind === 'environment'
      ? `runtime:${target.environmentId}:${repositoryKey}`
      : repositoryKey

  return useMetadataListRequest({
    cacheKey,
    store: slugLabelStore,
    errorFallback: 'Failed to load labels',
    load: () =>
      gitHubSlugApiForTarget(target, gitExecutionRepo)
        .listLabelsBySlug({
          owner: selectedOwner,
          repo: selectedRepo,
          host: githubProjectHost(host)
        })
        .then((res) => {
          if (!res.ok) {
            throw new Error(res.error.message)
          }
          return res.labels
        })
  })
}

export function useRepoAssigneesBySlug(
  owner: string | null,
  repo: string | null,
  seedLogins?: string[],
  ownerTarget?: RuntimeClientTarget | null,
  host?: string,
  context?: GitHubSlugMetadataContext
): MetadataListState<GitHubAssignableUser> {
  const seedKey = (seedLogins ?? []).slice().sort().join(',')
  const target: RuntimeClientTarget = ownerTarget ?? { kind: 'local' }
  const authority = useGitHubOperationOwner({ ...context, target }).scope
  const gitExecutionRepo = getGitHubGitExecutionRepo(
    context?.sourceContext,
    context?.repoId,
    context?.repoPath
  )
  const selectedOwner = owner ?? ''
  const selectedRepo = repo ?? ''
  const repositoryKey =
    owner && repo ? `${githubRepoIdentityKey({ owner, repo, host })}::${authority}` : null
  const cacheKey = repositoryKey
    ? target.kind === 'environment'
      ? `runtime:${target.environmentId}:${repositoryKey}`
      : repositoryKey
    : null
  const args = {
    owner: selectedOwner,
    repo: selectedRepo,
    host: githubProjectHost(host)
  }

  const base = useMetadataListRequest({
    cacheKey,
    store: slugAssigneeStore,
    errorFallback: 'Failed to load assignees',
    load: () =>
      gitHubSlugApiForTarget(target, gitExecutionRepo)
        .listAssignableUsersBySlug(args)
        .then((res) => {
          if (!res.ok) {
            throw new Error(res.error.message)
          }
          return res.users
        })
  })
  const data = useMemo(() => {
    if (!cacheKey || base.resolvedKey !== cacheKey || !seedKey) {
      return base.data
    }
    const users = [...base.data]
    const seen = new Set(users.map((user) => user.login))
    for (const login of seedKey.split(',')) {
      if (!seen.has(login)) {
        users.push({ login, name: null, avatarUrl: '' })
        seen.add(login)
      }
    }
    return users
  }, [base.data, base.resolvedKey, cacheKey, seedKey])
  return { data, loading: base.loading, error: base.error }
}
