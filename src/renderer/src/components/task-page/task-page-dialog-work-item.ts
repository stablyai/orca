import type { CacheEntry } from '@/store/github/cache/cache-model'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

type WorkItemsCache = Record<string, CacheEntry<readonly GitHubWorkItem[]>>

export type TaskPageDialogWorkItemKey = {
  id: string
  repoId: string
  url: string
  repoHostId?: GitHubWorkItem['repoHostId']
} | null

/** Prefers the row's current source binding: a retained older binding can hold an outdated copy of the same row. */
export function findTaskPageDialogWorkItem(
  workItemsCache: WorkItemsCache,
  dialogWorkItemKey: TaskPageDialogWorkItemKey,
  binding?: string
): GitHubWorkItem | null {
  if (!dialogWorkItemKey) {
    return null
  }
  let fallback: GitHubWorkItem | null = null
  for (const entry of Object.values(workItemsCache)) {
    // Why: once a fallback exists, another binding's copy can neither win nor replace it.
    if (fallback && binding && entry.sourceBinding !== binding) {
      continue
    }
    const found = entry?.data?.find(
      (wi) =>
        wi.id === dialogWorkItemKey.id &&
        wi.repoId === dialogWorkItemKey.repoId &&
        wi.url === dialogWorkItemKey.url &&
        // Why: a twin's other host caches the same PR; its copy routes edits to that host.
        (!dialogWorkItemKey.repoHostId || wi.repoHostId === dialogWorkItemKey.repoHostId)
    )
    if (found && (!binding || entry.sourceBinding === binding)) {
      return found
    }
    fallback ??= found ?? null
  }
  return fallback
}

/** The dialog row for one key and binding, recomputed only when the cache object changes. */
export function createTaskPageDialogWorkItemReader(
  dialogWorkItemKey: TaskPageDialogWorkItemKey,
  binding?: string
) {
  let last: { cache: WorkItemsCache; found: GitHubWorkItem | null } | undefined
  return (workItemsCache: WorkItemsCache) => {
    if (last?.cache !== workItemsCache) {
      last = {
        cache: workItemsCache,
        found: findTaskPageDialogWorkItem(workItemsCache, dialogWorkItemKey, binding)
      }
    }
    return last.found
  }
}
