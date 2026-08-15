import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

export type TaskPageGitHubListFamily = 'assignees' | 'reviewRequests'
export type TaskPageGitHubMutationKey = {
  sourceScope: string | null
  repoId: string
  itemId: string
  opKey: string
}
export type PendingListOp = {
  family: TaskPageGitHubListFamily
  kind: 'add' | 'remove'
  logins: string[]
  users?: GitHubAssignableUser[]
}
export type PendingOp = {
  generation: number
  key: TaskPageGitHubMutationKey
  previous: Partial<GitHubWorkItem>
  next: Partial<GitHubWorkItem>
  listOp?: PendingListOp
  skipMeQualifiers: boolean
  startedAt: number
}
export type StickyHideEntry = {
  itemKey: string
  sourceScope: string | null
  queryKey: string
  reason: 'filter_membership'
}
