import type { ParsedTaskQuery } from '../../../../../../shared/work-items/task-query'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import type { TaskSourceContext } from '../../../../../../shared/work-items/task-source-context'
import type { GitHubPatchWorkItemOptions } from '../../../../store/github/work-items/work-item-patch-options'
import type { TaskPageGitHubMutationIntent } from './task-page-github-work-item-mutation-patches'
import type { TaskPageGitHubMutationKey } from './task-page-github-work-item-registry-types'

export type TaskPageGitHubPatchWorkItem = (
  itemId: string,
  patch: Partial<GitHubWorkItem>,
  repoId?: string,
  options?: GitHubPatchWorkItemOptions
) => void

export type BeginTaskPageGitHubWorkItemMutationArgs = {
  settleAccepted?: (success: boolean) => GitHubWorkItem
  item: GitHubWorkItem
  intent: TaskPageGitHubMutationIntent
  sourceContext?: TaskSourceContext | null
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
  /** Derived inside begin from item sourceContext if omitted. */
  skipMeQualifiers?: boolean
  patchWorkItem: TaskPageGitHubPatchWorkItem
}

export type BeginTaskPageGitHubWorkItemMutationResult = {
  generation: number
  opKey: string
  itemKey: string
  families: string[]
  key: TaskPageGitHubMutationKey
}
