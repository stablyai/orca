import type { TaskPageGitHubMutationIntent } from '@/components/task-page-github-work-item-mutation-patches'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

export type TaskPageGitHubWorkItemMutationRunner = {
  run: (input: {
    item: GitHubWorkItem
    intent: TaskPageGitHubMutationIntent
    sourceContext?: TaskSourceContext | null
    mutate: () => Promise<{ ok?: boolean; error?: string | { message?: string } } | void>
    successToast?: string
    errorToast: string
  }) => Promise<'confirmed' | 'rolled_back' | 'stale'>
  isIntentPending: (input: {
    item: GitHubWorkItem
    intent: TaskPageGitHubMutationIntent
    sourceContext?: TaskSourceContext | null
  }) => boolean
}
