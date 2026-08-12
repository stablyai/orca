import type { ParsedTaskQuery } from '../../../shared/task-query'
import type { GitHubWorkItem } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { TaskPageGitHubMutationIntent } from './task-page-github-work-item-mutation-patches'
import type { TaskPageGitHubMutationKey } from './task-page-github-work-item-mutation-registry'

export type TaskPageGitHubPatchWorkItem = (
  itemId: string,
  patch: Partial<GitHubWorkItem>,
  repoId?: string,
  options?: { sourceContext?: TaskSourceContext | null }
) => void

export type BeginTaskPageGitHubWorkItemMutationArgs = {
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
