import { useAppStore } from '@/store'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import { untrackedTaskOperation, type TaskChange } from '@/store/github/task-change'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

/** Starts a dialog edit; the record (or the untracked publisher) owns every Tasks copy it touches. */
export function beginEdit(
  item: GitHubWorkItem,
  source: TaskSourceContext | null | undefined,
  change: TaskChange
) {
  const state = useAppStore.getState()
  const cache = state.githubTaskCache
  const binding = cache?.capture(getWorkItemRepo(state.repos, item), source)
  if (cache && binding) {
    return cache.operation(item, binding, change)
  }
  return untrackedTaskOperation(useAppStore, item, change, [source])
}
