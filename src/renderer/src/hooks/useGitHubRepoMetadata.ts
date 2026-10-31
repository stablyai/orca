import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { getGitHubRuntimeRepoId } from '@/lib/github-source-runtime-context'
import { callGitHubTargetOperation } from '@/lib/github-work-item-target-request'
import { useGitHubOperationOwner } from './useGitHubOperationScope'
import { useGitHubWorkItemTarget } from '@/components/github-item-dialog/load-item-details/github-work-item-target-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { createMetadataRequestStore } from './metadata-request-cache'
import { useMetadataListRequest, type MetadataListState } from './useMetadataListRequest'

type GitHubMetadataOptions = {
  /** The repo owner's transport; absent reads through this app. */
  target?: RuntimeClientTarget | null
  ownerRepo?: GitHubOwnerRepo | null
}

const ghLabelStore = createMetadataRequestStore<string[]>()
const ghAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function useRepoLabels(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<string> {
  const bound = useGitHubWorkItemTarget()
  const owner = useGitHubOperationOwner({
    target: bound?.target ?? options?.target,
    repoId,
    repoPath,
    sourceContext: bound?.sourceContext
  })
  const target = owner.target
  const runtimeEnvironmentId = target.kind === 'environment' ? target.environmentId : null
  const repoSelector = runtimeEnvironmentId
    ? (getGitHubRuntimeRepoId(bound?.sourceContext, repoId) ?? repoPath ?? '')
    : (repoId ?? repoPath ?? '')
  const ownerRepo = options?.ownerRepo ?? bound?.resource.repository
  const operationScope = owner.scope
  const repositoryKey = ownerRepo
    ? `${repoSelector}::${githubRepoIdentityKey(ownerRepo)}::${bound?.sourceContext ? getTaskSourceCacheScope(bound.sourceContext) : ''}::${operationScope}`
    : `${repoSelector}::${operationScope}`
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repositoryKey}`
        : repositoryKey
      : null

  const result = useMetadataListRequest({
    cacheKey,
    store: ghLabelStore,
    errorFallback: 'Failed to load labels',
    load: async () => {
      return callGitHubTargetOperation<string[]>({
        target,
        ownerRepo,
        method: 'github.listLabels',
        params: { repo: repoSelector },
        timeoutMs: 15_000,
        local: (exact) =>
          window.api.gh.listLabels({
            repoPath: repoPath ?? '',
            repoId: repoId ?? undefined,
            ...(bound?.sourceContext ? { sourceContext: bound.sourceContext } : {}),
            ...exact
          })
      })
    }
  })
  return {
    ...result,
    data: result.resolvedKey === cacheKey ? result.data : [],
    loading:
      result.loading || (cacheKey !== null && result.resolvedKey !== cacheKey && !result.error)
  }
}

export function useRepoAssignees(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<GitHubAssignableUser> {
  const bound = useGitHubWorkItemTarget()
  const owner = useGitHubOperationOwner({
    target: bound?.target ?? options?.target,
    repoId,
    repoPath,
    sourceContext: bound?.sourceContext
  })
  const target = owner.target
  const runtimeEnvironmentId = target.kind === 'environment' ? target.environmentId : null
  const repoSelector = runtimeEnvironmentId
    ? (getGitHubRuntimeRepoId(bound?.sourceContext, repoId) ?? repoPath ?? '')
    : (repoId ?? repoPath ?? '')
  const ownerRepo = options?.ownerRepo ?? bound?.resource.repository
  const operationScope = owner.scope
  const repositoryKey = ownerRepo
    ? `${repoSelector}::${githubRepoIdentityKey(ownerRepo)}::${bound?.sourceContext ? getTaskSourceCacheScope(bound.sourceContext) : ''}::${operationScope}`
    : `${repoSelector}::${operationScope}`
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repositoryKey}`
        : repositoryKey
      : null

  const result = useMetadataListRequest({
    cacheKey,
    store: ghAssigneeStore,
    errorFallback: 'Failed to load assignees',
    load: async () => {
      return callGitHubTargetOperation<GitHubAssignableUser[]>({
        target,
        ownerRepo,
        method: 'github.listAssignableUsers',
        params: { repo: repoSelector },
        timeoutMs: 15_000,
        local: (exact) =>
          window.api.gh.listAssignableUsers({
            repoPath: repoPath ?? '',
            repoId: repoId ?? undefined,
            ...(bound?.sourceContext ? { sourceContext: bound.sourceContext } : {}),
            ...exact
          })
      })
    }
  })
  return {
    ...result,
    data: result.resolvedKey === cacheKey ? result.data : [],
    loading:
      result.loading || (cacheKey !== null && result.resolvedKey !== cacheKey && !result.error)
  }
}
