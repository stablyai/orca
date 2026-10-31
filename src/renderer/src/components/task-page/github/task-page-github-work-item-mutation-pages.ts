import type { Dispatch, SetStateAction, MutableRefObject } from 'react'
import type { GitHubTaskRead } from '@/store/github/request-coordination'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import {
  getGitHubTaskObservation,
  patchObservedGitHubWorkItem,
  type ObservedGitHubWorkItem
} from '@/lib/github-task-observation'
import { githubTaskSourceKey } from '@/lib/github-task-target'
import { taskPageGitHubMutationItemId } from './task-page-github-work-item-mutation-keys'
import type { ListComposition } from './task-page-github-work-item-mutation-registry'
import {
  createTaskPageGitHubAuthorityProjection,
  adoptTaskPageGitHubMembershipFamilies
} from './task-page-github-work-item-mutation-composition'
import type { GitHubWorkItemPatch } from '@/store/github/cache-model'
import {
  admitTaskPageGitHubListInputs,
  materializeTaskPageItemList,
  createTaskPageGitHubMaterializer,
  type TaskPageGitHubProjectionContext
} from './task-page-github-work-item-materialization'
export {
  admitTaskPageGitHubListInputs,
  materializeTaskPageItemList,
  createTaskPageGitHubProjectionContext,
  taskPageGitHubObservedRowKey,
  type TaskPageGitHubProjectionContext
} from './task-page-github-work-item-materialization'

export function patchTaskPageGitHubWorkItemPages(
  pages: (readonly GitHubWorkItem[] | null)[],
  itemKey: { id: string; repoId: string },
  patch: Partial<ObservedGitHubWorkItem>,
  shouldPatch?: (item: GitHubWorkItem) => boolean,
  listComposition?: readonly ListComposition[]
): (readonly GitHubWorkItem[] | null)[]
export function patchTaskPageGitHubWorkItemPages(
  pages: readonly (readonly GitHubWorkItem[] | null)[],
  itemKey: { id: string; repoId: string },
  patch: Partial<ObservedGitHubWorkItem>,
  shouldPatch?: (item: GitHubWorkItem) => boolean,
  listComposition?: readonly ListComposition[]
): readonly (readonly GitHubWorkItem[] | null)[]
export function patchTaskPageGitHubWorkItemPages(
  pages: readonly (readonly GitHubWorkItem[] | null)[],
  itemKey: { id: string; repoId: string },
  patch: Partial<ObservedGitHubWorkItem>,
  shouldPatch?: (item: GitHubWorkItem) => boolean,
  listComposition: readonly ListComposition[] = []
): readonly (readonly GitHubWorkItem[] | null)[] {
  const projection = createTaskPageGitHubAuthorityProjection()
  let nextPages: (readonly GitHubWorkItem[] | null)[] | undefined
  pages.forEach((page, pageIndex) => {
    if (!page) {
      return
    }
    let nextPage: GitHubWorkItem[] | undefined
    page.forEach((item, itemIndex) => {
      if (
        item.repoId !== itemKey.repoId ||
        (shouldPatch ? !shouldPatch(item) : item.id !== itemKey.id)
      ) {
        return
      }
      let updated = Object.keys(patch).length
        ? patchObservedGitHubWorkItem(item, patch, patch.githubValueOrigins ?? {})
        : item
      for (const plan of listComposition) {
        updated = projection.list(updated, plan)
      }
      if (updated === item) {
        return
      }
      nextPage ??= page.slice()
      nextPage[itemIndex] = updated
    })
    if (nextPage) {
      nextPages ??= pages.slice()
      nextPages[pageIndex] = nextPage
    }
  })
  return nextPages ?? pages
}

export function applyPendingTaskPageGitHubMutationsToItems(
  items: readonly GitHubWorkItem[],
  context?: TaskPageGitHubProjectionContext
): GitHubWorkItem[] {
  const compose = createTaskPageGitHubAuthorityProjection()
  return items.map((item) => {
    const owner = context?.ownerOf?.(item) ?? getGitHubTaskObservation(item)
    return compose(item, owner ? githubTaskSourceKey(owner.source) : null, owner)
  })
}
export function reapplyPendingTaskPageGitHubMutationsToCache(args: {
  items: readonly GitHubWorkItem[]
  patchWorkItems: (patches: readonly GitHubWorkItemPatch[]) => void
  context?: TaskPageGitHubProjectionContext
}): void {
  admitTaskPageGitHubListInputs(args.items, args.context, true)
  const compose = createTaskPageGitHubAuthorityProjection()
  const patches: GitHubWorkItemPatch[] = []
  for (const item of args.items) {
    const owner = args.context?.ownerOf?.(item) ?? getGitHubTaskObservation(item)
    const merged = compose(item, owner ? githubTaskSourceKey(owner.source) : null, owner)
    if (merged === item) {
      continue
    }
    patches.push({
      itemId: item.id,
      patch: {
        state: merged.state,
        autoMergeEnabled: merged.autoMergeEnabled
      },
      repoId: item.repoId,
      options: {
        sourceContext: owner?.source,
        observation: owner,
        valueOrigins: {
          state: merged.githubValueOrigins?.state,
          autoMerge: merged.githubValueOrigins?.autoMerge
        },
        listComposition: (['assignees', 'reviewRequests'] as const).map((family) => ({
          address: {
            sourceScope: owner ? githubTaskSourceKey(owner.source) : null,
            repoId: item.repoId,
            itemId: taskPageGitHubMutationItemId(item),
            itemType: item.type,
            observation: owner,
            family
          }
        })),
        ownerRepo: item.type === 'issue' ? parseGitHubIssueOrPRLink(item.url)?.slug : undefined
      }
    })
  }
  args.patchWorkItems(patches)
}
export function reconcileTaskPagePagesAfterQuietRefresh(args: {
  pages: readonly (readonly GitHubWorkItem[] | null)[]
  queryKey: string
  authorityPage: number
  authorityItems: readonly GitHubWorkItem[]
  membershipChanged: boolean
  visiblePage?: number
  visibleItems?: readonly GitHubWorkItem[]
  context?: TaskPageGitHubProjectionContext
}): (readonly GitHubWorkItem[] | null)[] {
  const next = [...args.pages]
  const lastPage = args.visiblePage ?? args.authorityPage
  while (next.length <= lastPage) {
    next.push(null)
  }
  next[args.authorityPage] = materializeTaskPageItemList({
    networkItems: args.authorityItems,
    previousItems: args.pages[args.authorityPage] ?? [],
    queryKey: args.queryKey,
    context: args.context
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
      queryKey: args.queryKey,
      context: args.context
    })
  }
  if (args.membershipChanged) {
    next.length = lastPage + 1
  }
  return next
}

/** In-place overlay per page; preserves multi-page structure; no retain. */
export function overlayPendingOnTaskPagePages(
  pages: readonly (readonly GitHubWorkItem[])[],
  context?: TaskPageGitHubProjectionContext
): GitHubWorkItem[][] {
  return pages.map((page) => applyPendingTaskPageGitHubMutationsToItems(page, context))
}

export function materializeTaskPageGitHubRead(
  read: GitHubTaskRead,
  pages: readonly (readonly GitHubWorkItem[] | null)[],
  items: readonly GitHubWorkItem[],
  queryKey: string,
  context?: TaskPageGitHubProjectionContext
): GitHubWorkItem[] {
  const current = pages.flatMap((page) => page ?? [])
  return materializeTaskPageItemList({
    networkItems: read.apply(items, current),
    previousItems: current,
    queryKey,
    context
  })
}
export function restoreTaskPageGitHubReadPage(
  read: GitHubTaskRead,
  pages: readonly (readonly GitHubWorkItem[] | null)[],
  items: readonly GitHubWorkItem[],
  page: number,
  context?: TaskPageGitHubProjectionContext
): (readonly GitHubWorkItem[] | null)[] {
  const next = [...pages]
  while (next.length <= page) {
    next.push(null)
  }
  next[page] =
    overlayPendingOnTaskPagePages(
      [
        read.apply(
          items,
          pages.flatMap((p) => p ?? [])
        )
      ],
      context
    )[0] ?? []
  return next
}

export { transitionTaskPageGitHubMutationQuery } from './task-page-github-work-item-query-transition'

export function deliverTaskPageGitHubRead(
  read: GitHubTaskRead,
  items: readonly GitHubWorkItem[],
  setPages: Dispatch<SetStateAction<(readonly GitHubWorkItem[] | null)[]>>,
  pagesRef: MutableRefObject<(readonly GitHubWorkItem[] | null)[]>,
  context: TaskPageGitHubProjectionContext,
  assign: (
    pages: (readonly GitHubWorkItem[] | null)[],
    rows: readonly GitHubWorkItem[],
    materialize: ReturnType<typeof createTaskPageGitHubMaterializer>
  ) => (readonly GitHubWorkItem[] | null)[]
): void {
  read.deliver(items, (update) => {
    for (const item of items) {
      const owner = context.ownerOf?.(item) ?? getGitHubTaskObservation(item)
      adoptTaskPageGitHubMembershipFamilies(
        item,
        owner ? githubTaskSourceKey(owner.source) : null,
        context.queryKey,
        owner
      )
    }
    const materialize = createTaskPageGitHubMaterializer(context)
    const transition = Object.assign(
      (current: (readonly GitHubWorkItem[] | null)[]) => {
        const previous = current.flatMap((page) => page ?? [])
        return assign(current, update(previous), materialize)
      },
      {
        commit:
          'commit' in update && typeof update.commit === 'function' ? update.commit : undefined
      }
    )
    pagesRef.current = transition(pagesRef.current)
    setPages(transition)
  })
}
