import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { createMetadataRequestStore } from './metadata-request-cache'
import { useMetadataListRequest, type MetadataListState } from './useMetadataListRequest'

type GitHubMetadataOptions = {
  runtimeEnvironmentId?: string | null
  activeRuntimeEnvironmentId?: string | null
  ownerRepo?: GitHubOwnerRepo | null
}

const ghLabelStore = createMetadataRequestStore<string[]>()
const ghAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function useRepoLabels(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<string> {
  const runtimeEnvironmentId =
    options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
  const repoSelector = repoId ?? repoPath ?? ''
  const ownerRepo = runtimeEnvironmentId ? null : options?.ownerRepo
  const repositoryKey = ownerRepo
    ? `${repoSelector}::${githubRepoIdentityKey(ownerRepo)}`
    : repoSelector
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repoSelector}`
        : repositoryKey
      : null

  return useMetadataListRequest({
    cacheKey,
    store: ghLabelStore,
    errorFallback: 'Failed to load labels',
    load: () =>
      runtimeEnvironmentId
        ? callRuntimeRpc<string[]>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.listLabels',
            { repo: repoSelector },
            { timeoutMs: 15_000 }
          )
        : window.api.gh.listLabels({
            repoPath: repoPath ?? '',
            repoId: repoId ?? undefined,
            ...(ownerRepo ? { ownerRepo } : {})
          })
  })
}

export function useRepoAssignees(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<GitHubAssignableUser> {
  const runtimeEnvironmentId =
    options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
  const repoSelector = repoId ?? repoPath ?? ''
  const ownerRepo = runtimeEnvironmentId ? null : options?.ownerRepo
  const repositoryKey = ownerRepo
    ? `${repoSelector}::${githubRepoIdentityKey(ownerRepo)}`
    : repoSelector
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repoSelector}`
        : repositoryKey
      : null

  return useMetadataListRequest({
    cacheKey,
    store: ghAssigneeStore,
    errorFallback: 'Failed to load assignees',
    load: () =>
      runtimeEnvironmentId
        ? callRuntimeRpc<GitHubAssignableUser[]>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.listAssignableUsers',
            { repo: repoSelector },
            { timeoutMs: 15_000 }
          )
        : window.api.gh.listAssignableUsers({
            repoPath: repoPath ?? '',
            repoId: repoId ?? undefined,
            ...(ownerRepo ? { ownerRepo } : {})
          })
  })
}
