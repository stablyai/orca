import type { GitHubWorkItem } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getRegistryMergedTaskPageGitHubWorkItem } from './task-page-github-work-item-mutation-composition'
import {
  getStickyHideEntry,
  hasConfirmedAuthorityForItem,
  hasPendingTaskPageGitHubOpsForItem,
  resolveItemSourceScope,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-registry'
import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'

export function patchTaskPageGitHubWorkItemPages(
  pages: readonly (GitHubWorkItem[] | null)[],
  itemKey: { id: string; repoId: string },
  patch: Partial<GitHubWorkItem>,
  shouldPatch?: (item: GitHubWorkItem) => boolean
): (GitHubWorkItem[] | null)[] {
  let changed = false
  const nextPages = pages.map((page) => {
    if (!page) {
      return null
    }
    let pageChanged = false
    const nextPage = page.map((item) => {
      if (
        item.id !== itemKey.id ||
        item.repoId !== itemKey.repoId ||
        (shouldPatch && !shouldPatch(item))
      ) {
        return item
      }
      changed = true
      pageChanged = true
      return { ...item, ...patch }
    })
    return pageChanged ? nextPage : page
  })
  return changed ? nextPages : (pages as (GitHubWorkItem[] | null)[])
}

/** Match each item to pending/confirmed authority by repoId + itemId + remembered sourceScope. */
export function applyPendingTaskPageGitHubMutationsToItems(
  items: readonly GitHubWorkItem[]
): GitHubWorkItem[] {
  return items.map((item) => {
    const sourceScope = resolveItemSourceScope(item.repoId, item.id)
    return getRegistryMergedTaskPageGitHubWorkItem(item, sourceScope)
  })
}

export function reapplyPendingTaskPageGitHubMutationsToCache(args: {
  items: readonly GitHubWorkItem[]
  patchWorkItem: TaskPageGitHubPatchWorkItem
  sourceContextByRepoId?: ReadonlyMap<string, TaskSourceContext | null | undefined>
}): void {
  for (const item of args.items) {
    const sourceScope = resolveItemSourceScope(item.repoId, item.id)
    const hasAuthority =
      hasPendingTaskPageGitHubOpsForItem(item.repoId, item.id) ||
      hasConfirmedAuthorityForItem(item.repoId, item.id)
    if (!hasAuthority) {
      continue
    }
    const merged = getRegistryMergedTaskPageGitHubWorkItem(item, sourceScope)
    args.patchWorkItem(
      item.id,
      {
        state: merged.state,
        assignees: merged.assignees,
        reviewRequests: merged.reviewRequests,
        autoMergeEnabled: merged.autoMergeEnabled
      },
      item.repoId,
      { sourceContext: args.sourceContextByRepoId?.get(item.repoId) }
    )
  }
}

/** Full-replace flat list: overlay + retain pending/confirmed-omitted rows (K18). */
export function materializeTaskPageItemList(args: {
  networkItems: readonly GitHubWorkItem[]
  previousItems: readonly GitHubWorkItem[]
  queryKey: string
}): GitHubWorkItem[] {
  const overlaid = applyPendingTaskPageGitHubMutationsToItems(args.networkItems)
  const byKey = new Map(overlaid.map((item) => [taskPageGitHubItemKey(item.repoId, item.id), item]))
  for (const item of args.previousItems) {
    const k = taskPageGitHubItemKey(item.repoId, item.id)
    if (byKey.has(k)) {
      continue
    }
    // Why: retain in-flight pending rows for rollback visibility; also retain
    // confirmed rows soft-hidden by a sticky hide scoped to THIS query while
    // search lag omits them. Requiring the query-scoped sticky avoids retaining
    // non-membership confirms (e.g. auto-merge) as stale ghosts across refetch.
    const hasPending = hasPendingTaskPageGitHubOpsForItem(item.repoId, item.id)
    const sticky = getStickyHideEntry(k)
    const hasConfirmedStickyHide =
      hasConfirmedAuthorityForItem(item.repoId, item.id) && sticky?.queryKey === args.queryKey
    if (!hasPending && !hasConfirmedStickyHide) {
      continue
    }
    const scope = resolveItemSourceScope(item.repoId, item.id)
    byKey.set(k, getRegistryMergedTaskPageGitHubWorkItem(item, scope))
  }
  return [...byKey.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
}

export function reconcileTaskPagePagesAfterQuietRefresh(args: {
  pages: readonly (GitHubWorkItem[] | null)[]
  queryKey: string
  authorityPage: number
  authorityItems: readonly GitHubWorkItem[]
  membershipChanged: boolean
  visiblePage?: number
  visibleItems?: readonly GitHubWorkItem[]
}): (GitHubWorkItem[] | null)[] {
  const next = [...args.pages]
  const lastPage = args.visiblePage ?? args.authorityPage
  while (next.length <= lastPage) {
    next.push(null)
  }
  next[args.authorityPage] = materializeTaskPageItemList({
    networkItems: args.authorityItems,
    previousItems: args.pages[args.authorityPage] ?? [],
    queryKey: args.queryKey
  })
  if (args.visiblePage !== undefined && args.visibleItems !== undefined) {
    if (args.membershipChanged) {
      for (let page = args.authorityPage + 1; page < args.visiblePage; page++) {
        next[page] = null
      }
    }
    next[args.visiblePage] = materializeTaskPageItemList({
      networkItems: args.visibleItems,
      previousItems: args.pages[args.visiblePage] ?? [],
      queryKey: args.queryKey
    })
  }
  if (args.membershipChanged) {
    next.length = lastPage + 1
  }
  return next
}

/** In-place overlay per page; preserves multi-page structure; no retain. */
export function overlayPendingOnTaskPagePages(
  pages: readonly GitHubWorkItem[][]
): GitHubWorkItem[][] {
  return pages.map((page) => applyPendingTaskPageGitHubMutationsToItems(page))
}
