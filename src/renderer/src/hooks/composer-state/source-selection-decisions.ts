import type { GitHubPrStartPoint, GitPushTarget } from '../../../../shared/worktree/types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { getLinkedWorkItemProvider, type LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { SmartGitHubSubmitResolution } from '@/lib/smart-github-submit'
import {
  resolveGitHubWorkItemIdentity,
  type GitHubWorkItemIdentity
} from '@/lib/github-work-item-identity'

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
  repoId: string
  item: GitHubWorkItem
  resolved?: GitHubPrStartPoint
}

export function getGitHubLinkedWorkItemIdentity(
  item: LinkedWorkItemSummary | null | undefined
): GitHubWorkItemIdentity | null {
  if (!item || getLinkedWorkItemProvider(item) !== 'github') {
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
  if (!item || getLinkedWorkItemProvider(item) !== 'github') {
    return item ?? null
  }
  const identity = getGitHubLinkedWorkItemIdentity(item)
  if (!identity || (identity.type === item.type && identity.number === item.number)) {
    return item
  }
  return { ...item, type: identity.type, number: identity.number }
}
