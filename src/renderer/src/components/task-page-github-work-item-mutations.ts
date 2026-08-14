import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import {
  buildTaskPageGitHubWorkItemMutationPatch,
  type TaskPageGitHubMutationIntent
} from './task-page-github-work-item-mutation-patches'
import {
  familiesFromPendingOp,
  getRegistryMergedTaskPageGitHubWorkItem,
  recomputeSoftHideForItem,
  rebuildSoftHiddenKeysFromPendingAndSticky,
  stripFamilyPendingFromList
} from './task-page-github-work-item-mutation-composition'
import {
  getConfirmedListSnapshot,
  getPendingTaskPageGitHubOp,
  getStickyHideEntry,
  listPendingTaskPageGitHubOpsForItem,
  nextTaskPageGitHubMutationGeneration,
  notifyTaskPageGitHubMutationRegistry,
  setConfirmedListSnapshot,
  setPendingTaskPageGitHubOp,
  setTaskPageGitHubMutationQueryKey,
  taskPageGitHubItemKey,
  type PendingOp,
  type TaskPageGitHubMutationKey
} from './task-page-github-work-item-mutation-registry'
import type {
  BeginTaskPageGitHubWorkItemMutationArgs,
  BeginTaskPageGitHubWorkItemMutationResult
} from './task-page-github-work-item-mutation-types'
import type { ParsedTaskQuery } from '../../../shared/task-query'

export type {
  BeginTaskPageGitHubWorkItemMutationArgs,
  BeginTaskPageGitHubWorkItemMutationResult,
  TaskPageGitHubPatchWorkItem
} from './task-page-github-work-item-mutation-types'

export {
  applyPendingTaskPageGitHubMutationsToItems,
  materializeTaskPageItemList,
  overlayPendingOnTaskPagePages,
  patchTaskPageGitHubWorkItemPages,
  reapplyPendingTaskPageGitHubMutationsToCache,
  reconcileTaskPagePagesAfterQuietRefresh
} from './task-page-github-work-item-mutation-pages'

export {
  adoptQuietSearchFieldsForItem,
  advanceTaskPageQuietRevalidateScope,
  getTaskPageQuietRevalidateBackoffAttempt,
  isTaskPageQuietRevalidateRunCurrent,
  isTaskPageQuietRevalidateScopeCurrent,
  processTaskPageQuietRevalidateSettle,
  settleQuietSearchRevalidate,
  LAG_BACKOFF_MS,
  LAG_WALL_BUDGET_MS,
  MAX_LAG_TRAILS
} from './task-page-github-work-item-quiet-revalidate'

export type { TaskPageQuietRevalidateScope } from './task-page-github-work-item-quiet-revalidate'

export {
  clearTaskPageGitHubAuthorityAbsentFromLoadedItems,
  clearTaskPageGitHubAuthorityThroughGeneration,
  getTaskPageGitHubRevalidatableAuthorityItemKeys
} from './task-page-github-work-item-authority-refresh'

export {
  clearTaskPageGitHubConfirmedAuthority,
  resolveItemSourceScope
} from './task-page-github-work-item-mutation-registry'

export {
  confirmTaskPageGitHubWorkItemMutation,
  rollbackTaskPageGitHubWorkItemMutation
} from './task-page-github-work-item-mutation-lifecycle'

export { getRegistryMergedTaskPageGitHubWorkItem } from './task-page-github-work-item-mutation-composition'
export { rebuildSoftHiddenKeysFromPendingAndSticky } from './task-page-github-work-item-mutation-composition'

export { setTaskPageGitHubMutationQueryKey, taskPageGitHubItemKey }

function resolveSourceScope(sourceContext?: TaskSourceContext | null): string | null {
  if (sourceContext?.provider === 'github') {
    return getTaskSourceCacheScope(sourceContext)
  }
  return null
}

function resolveTaskPageGitHubMutation(args: {
  item: GitHubWorkItem
  intent: TaskPageGitHubMutationIntent
  sourceContext?: TaskSourceContext | null
}) {
  const sourceScope = resolveSourceScope(args.sourceContext)
  const base = getRegistryMergedTaskPageGitHubWorkItem(args.item, sourceScope)
  return {
    sourceScope,
    built: buildTaskPageGitHubWorkItemMutationPatch(base, args.intent)
  }
}

export function canStartTaskPageGitHubWorkItemMutation(args: {
  item: GitHubWorkItem
  intent: TaskPageGitHubMutationIntent
  sourceContext?: TaskSourceContext | null
}): boolean {
  const { sourceScope, built } = resolveTaskPageGitHubMutation(args)
  const key = {
    sourceScope,
    repoId: args.item.repoId,
    itemId: args.item.id,
    opKey: built.opKey
  }
  if (isTaskPageGitHubMutationPendingKey(key)) {
    return false
  }
  const pending = listPendingTaskPageGitHubOpsForItem(args.item.repoId, args.item.id, sourceScope)
  if (built.kind === 'list') {
    const affectedLogins = new Set(built.listOp.logins)
    return !pending.some(
      (op) =>
        op.listOp?.family === built.family &&
        op.listOp.logins.some((login) => affectedLogins.has(login))
    )
  }
  return !pending.some(
    (op) =>
      !op.listOp && familiesFromPendingOp(op).some((family) => built.families.includes(family))
  )
}

export function beginTaskPageGitHubWorkItemMutation(
  args: BeginTaskPageGitHubWorkItemMutationArgs
): BeginTaskPageGitHubWorkItemMutationResult {
  setTaskPageGitHubMutationQueryKey(args.queryKey)
  const { sourceScope, built } = resolveTaskPageGitHubMutation(args)
  const skipMeQualifiers = args.skipMeQualifiers ?? false
  const key = {
    sourceScope,
    repoId: args.item.repoId,
    itemId: args.item.id,
    opKey: built.opKey
  }
  const generation = nextTaskPageGitHubMutationGeneration(key)

  if (built.kind === 'list') {
    const existing = getConfirmedListSnapshot(
      sourceScope,
      args.item.repoId,
      args.item.id,
      built.family
    )
    if (!existing) {
      const ops = listPendingTaskPageGitHubOpsForItem(args.item.repoId, args.item.id, sourceScope)
      const snapshot = stripFamilyPendingFromList(args.item, built.family, ops)
      setConfirmedListSnapshot(sourceScope, args.item.repoId, args.item.id, built.family, snapshot)
    }
  }

  const op: PendingOp = {
    generation,
    key,
    previous: built.previous,
    next: built.next,
    listOp: built.kind === 'list' ? built.listOp : undefined,
    skipMeQualifiers,
    startedAt: Date.now()
  }
  setPendingTaskPageGitHubOp(op)

  const merged = getRegistryMergedTaskPageGitHubWorkItem(args.item, sourceScope)
  const composedFields: Partial<GitHubWorkItem> =
    built.kind === 'list'
      ? built.family === 'assignees'
        ? { assignees: merged.assignees }
        : { reviewRequests: merged.reviewRequests }
      : built.next

  args.patchWorkItem(args.item.id, composedFields, args.item.repoId, {
    sourceContext: args.sourceContext
  })

  recomputeSoftHideForItem({
    item: { ...args.item, ...merged },
    sourceScope,
    query: args.query,
    queryKey: args.queryKey,
    viewerLogin: args.viewerLogin,
    skipMeQualifiers,
    updateSticky: false
  })
  notifyTaskPageGitHubMutationRegistry()

  return {
    generation,
    opKey: built.opKey,
    itemKey: taskPageGitHubItemKey(args.item.repoId, args.item.id),
    families: built.families,
    key
  }
}

export function isTaskPageGitHubMutationPendingKey(key: TaskPageGitHubMutationKey): boolean {
  return getPendingTaskPageGitHubOp(key) !== undefined
}

export function getTaskPageGitHubStickyHideForTests(itemKey: string) {
  return getStickyHideEntry(itemKey)
}

export function rebuildSoftHiddenFromItemsForTests(args: {
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
  items: readonly GitHubWorkItem[]
}): void {
  rebuildSoftHiddenKeysFromPendingAndSticky(args)
}
