import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { GitHubAssignableUser, GlobalSettings } from '../../../shared/types'
import type {
  ListAssignableUsersBySlugResult,
  ListLabelsBySlugResult
} from '../../../shared/github-project-types'
import { clearMetadataRequestStore, createMetadataRequestStore } from './metadata-request-cache'
import { githubRepoIdentityKey } from '../../../shared/github-repository-identity-key'
import { githubProjectHost } from '../../../shared/github-project-identity'
import { useMetadataListRequest, type MetadataListState } from './useMetadataListRequest'

const slugLabelStore = createMetadataRequestStore<string[]>()
const slugAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function clearGitHubSlugMetadataCache(): void {
  clearMetadataRequestStore(slugLabelStore)
  clearMetadataRequestStore(slugAssigneeStore)
}

export function useRepoLabelsBySlug(
  owner: string | null,
  repo: string | null,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  host?: string
): MetadataListState<string> {
  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId ?? null
  const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId })
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
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  host?: string
): MetadataListState<GitHubAssignableUser> {
  const seedKey = (seedLogins ?? []).slice().sort().join(',')
  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId ?? null
  const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId })
  const selectedOwner = owner ?? ''
  const selectedRepo = repo ?? ''
  const repositoryKey = owner && repo ? githubRepoIdentityKey({ owner, repo, host }) : null
  const cacheKey = repositoryKey
    ? target.kind === 'environment'
      ? `runtime:${target.environmentId}:${repositoryKey}#${seedKey}`
      : `${repositoryKey}#${seedKey}`
    : null
  const args = {
    owner: selectedOwner,
    repo: selectedRepo,
    host: githubProjectHost(host),
    ...(seedKey ? { seedLogins: seedKey.split(',') } : {})
  }

  return useMetadataListRequest({
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
}
