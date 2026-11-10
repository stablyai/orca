import type { GitHubPrStartPoint, GitPushTarget } from '../../../../shared/worktree/types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { getWorkspaceSourceProvider } from '../../../../shared/new-workspace/workspace-source'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { SmartGitHubSubmitResolution } from '@/lib/work-items/github/smart-github-submit'
import {
  resolveGitHubWorkItemIdentity,
  type GitHubWorkItemIdentity
} from '../../../../shared/new-workspace/github-work-item-identity'

export type PendingSmartGitHubSubmitResolution =
  | { kind: 'none' }
  | (SmartGitHubSubmitResolution & { kind: 'metadata-only' })
  | (SmartGitHubSubmitResolution & {
      kind: 'pr-start-point'
      baseBranch: string
      compareBaseRef?: string
      pushTarget?: GitPushTarget
      branchNameOverride?: string
    })

export type SmartGitHubPrStartPointSelection = {
  kind: 'github-pr'
  repoId: string
  item: GitHubWorkItem
  resolved?: GitHubPrStartPoint
}

export type SmartSourceSelection =
  | SmartGitHubPrStartPointSelection
  | { kind: 'gitlab-mr'; repoId: string; item: GitLabWorkItem }
  | { kind: 'github-submit-lookup'; query: string }

export function getGitHubLinkedWorkItemIdentity(
  item: LinkedWorkItemSummary | null | undefined
): GitHubWorkItemIdentity | null {
  if (!item || getWorkspaceSourceProvider(item) !== 'github') {
    return null
  }
  return resolveGitHubWorkItemIdentity({
    type: item.type as 'issue' | 'pr',
    number: item.number,
    url: item.url
  })
}

export function normalizeGitHubLinkedWorkItem(
  item: LinkedWorkItemSummary | null | undefined
): LinkedWorkItemSummary | null {
  if (!item || getWorkspaceSourceProvider(item) !== 'github') {
    return item ?? null
  }
  const identity = getGitHubLinkedWorkItemIdentity(item)
  if (!identity || (identity.type === item.type && identity.number === item.number)) {
    return item
  }
  return { ...item, type: identity.type, number: identity.number }
}
