import { useAppStore } from '@/store'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import type { TaskDelta } from '@/store/github/task-record-cache'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function beginEdit(
  item: GitHubWorkItem,
  source: TaskSourceContext | null | undefined,
  delta: TaskDelta
) {
  const state = useAppStore.getState()
  const cache = state.githubTaskCache
  const binding = cache?.capture(getWorkItemRepo(state.repos, item), source)
  if (cache && binding) {
    return cache.operation(item, binding, delta)
  }
  return (success: boolean) => {
    const current = success ? delta(item) : item
    if (success) {
      state.patchWorkItem(item.id, current, item.repoId, {
        sourceContext: source,
        ownerRepo: parseGitHubIssueOrPRLink(item.url)?.slug
      })
    }
    return current
  }
}
