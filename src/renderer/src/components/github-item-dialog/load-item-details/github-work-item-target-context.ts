import { useGitHubOperationOwner } from '@/hooks/useGitHubOperationScope'
import { canUseGitHubRepoContext } from '@/lib/github-source-runtime-context'
import {
  resolvePullRequestRepo,
  parseOwnerRepoFromItemUrl
} from '@/components/github/github-work-item-identity'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubItemDialogProjectOrigin } from './github-item-dialog-types'
import { getWorkItemDetailsCacheKey } from './work-item-details-cache'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { createContext, useContext, useMemo } from 'react'
import type { GitHubWorkItemTarget } from '../../../../../shared/github/work-item-target'

export const GitHubWorkItemTargetContext = createContext<{
  resource: GitHubWorkItemTarget
  target: RuntimeClientTarget
  sourceContext?: TaskSourceContext | null
} | null>(null)

export function useGitHubWorkItemTarget() {
  return useContext(GitHubWorkItemTargetContext)
}

export function useGitHubItemTargetIdentity({
  workItem,
  repoPath,
  effectiveRepoId,
  sourceContext,
  projectOrigin
}: {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: GitHubItemDialogProjectOrigin
}) {
  const owner = useGitHubOperationOwner({ repoId: effectiveRepoId, repoPath, sourceContext })
  const issueSourcePreference = owner.issueSourcePreference
  const canUseDetailsRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const repository = useMemo(
    () =>
      workItem
        ? workItem.type === 'pr'
          ? resolvePullRequestRepo(workItem, projectOrigin)
          : (projectOrigin ?? parseOwnerRepoFromItemUrl(workItem.url))
        : null,
    [projectOrigin, workItem]
  )
  const resource = useMemo(
    () =>
      workItem && repository
        ? { repository: repository, type: workItem.type, number: workItem.number }
        : null,
    [workItem, repository]
  )
  const operationScope = owner.scope
  const detailsCacheKey = useMemo(() => {
    if (!workItem || !effectiveRepoId || !canUseDetailsRepoContext) {
      return null
    }
    return getWorkItemDetailsCacheKey({
      repoPath: repoPath ?? '',
      repoId: effectiveRepoId,
      issueSourcePreference,
      sourceContext,
      sourceCacheScope:
        sourceContext?.provider === 'github'
          ? `${getTaskSourceCacheScope(sourceContext)}::${operationScope}`
          : operationScope,
      type: workItem.type,
      number: workItem.number,
      ownerRepo: repository
    })
  }, [
    canUseDetailsRepoContext,
    repoPath,
    effectiveRepoId,
    sourceContext,
    workItem,
    issueSourcePreference,
    repository,
    operationScope
  ])

  return { resource, detailsCacheKey, canUseDetailsRepoContext, operationTarget: owner.target }
}

export function useGitHubItemTargetContext({
  resource,
  effectiveRepoId,
  sourceContext
}: {
  resource: GitHubWorkItemTarget | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
}) {
  const owner = useGitHubOperationOwner({ repoId: effectiveRepoId, sourceContext })
  return useMemo(
    () =>
      resource && effectiveRepoId
        ? {
            resource,
            target: owner.target,
            sourceContext
          }
        : null,
    [resource, effectiveRepoId, sourceContext, owner]
  )
}
