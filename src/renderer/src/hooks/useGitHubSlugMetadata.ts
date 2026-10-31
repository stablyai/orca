import { useMemo } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type {
  ListAssignableUsersBySlugResult,
  ListLabelsBySlugResult,
  ListReviewTeamsBySlugResult
} from '../../../shared/github/project-result-types'
import { clearMetadataRequestStore, createMetadataRequestStore } from './metadata-request-cache'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { useMetadataListRequest, type MetadataListState } from './useMetadataListRequest'

const slugLabelStore = createMetadataRequestStore<string[]>()
const slugAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()
const slugReviewTeamStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function clearGitHubSlugMetadataCache(): void {
  clearMetadataRequestStore(slugLabelStore)
  clearMetadataRequestStore(slugAssigneeStore)
  clearMetadataRequestStore(slugReviewTeamStore)
}

export function useRepoLabelsBySlug(
  owner: string | null,
  repo: string | null,
  ownerTarget?: RuntimeClientTarget | null,
  host?: string
): MetadataListState<string> {
  const target: RuntimeClientTarget = ownerTarget ?? { kind: 'local' }
  const selectedOwner = owner ?? ''
  const selectedRepo = repo ?? ''
  const repositoryKey = owner && repo ? githubRepoIdentityKey({ owner, repo, host }) : null
  const cacheKey =
    repositoryKey && target.kind === 'environment'
      ? `runtime:${target.environmentId}:${repositoryKey}`
      : repositoryKey

  return useMetadataListRequest({
    cacheKey,
    store: slugLabelStore,
    errorFallback: 'Failed to load labels',
    load: () =>
      (target.kind === 'environment'
        ? callRuntimeRpc<ListLabelsBySlugResult>(
            target,
            'github.project.listLabelsBySlug',
            { owner: selectedOwner, repo: selectedRepo, host: githubProjectHost(host) },
            { timeoutMs: 30_000 }
          )
        : window.api.gh.listLabelsBySlug({
            owner: selectedOwner,
            repo: selectedRepo,
            host: githubProjectHost(host)
          })
      ).then((res) => {
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
  host?: string
): MetadataListState<GitHubAssignableUser> {
  const seedKey = (seedLogins ?? []).slice().sort().join(',')
  const target: RuntimeClientTarget = ownerTarget ?? { kind: 'local' }
  const selectedOwner = owner ?? ''
  const selectedRepo = repo ?? ''
  const repositoryKey = owner && repo ? githubRepoIdentityKey({ owner, repo, host }) : null
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
      (target.kind === 'environment'
        ? callRuntimeRpc<ListAssignableUsersBySlugResult>(
            target,
            'github.project.listAssignableUsersBySlug',
            args,
            { timeoutMs: 30_000 }
          )
        : window.api.gh.listAssignableUsersBySlug(args)
      ).then((res) => {
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

export function useRepoReviewTeamsBySlug(
  owner: string | null,
  repo: string | null,
  ownerTarget?: RuntimeClientTarget | null,
  host?: string
): MetadataListState<GitHubAssignableUser> {
  const target: RuntimeClientTarget = ownerTarget ?? { kind: 'local' }
  const repositoryKey = owner && repo ? githubRepoIdentityKey({ owner, repo, host }) : null
  const cacheKey =
    repositoryKey && target.kind === 'environment'
      ? `runtime:${target.environmentId}:${repositoryKey}`
      : repositoryKey
  const args = { owner: owner ?? '', repo: repo ?? '', host: githubProjectHost(host) }

  return useMetadataListRequest({
    cacheKey,
    store: slugReviewTeamStore,
    errorFallback: 'Failed to load teams',
    load: () =>
      (target.kind === 'environment'
        ? callRuntimeRpc<ListReviewTeamsBySlugResult>(
            target,
            'github.project.listReviewTeamsBySlug',
            args,
            { timeoutMs: 30_000 }
          )
        : window.api.gh.listReviewTeamsBySlug(args)
      ).then((res) => {
        if (!res.ok) {
          throw new Error(res.error.message)
        }
        return res.teams
      })
  })
}
