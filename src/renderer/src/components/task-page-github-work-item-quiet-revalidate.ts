import type { GitHubWorkItem } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  adoptQuietSearchFieldsForItem,
  LAG_BACKOFF_MS,
  LAG_WALL_BUDGET_MS,
  MAX_LAG_TRAILS
} from './task-page-github-work-item-quiet-adopt'
import {
  clearConfirmedAuthorityForItem,
  gcStickyHidesAbsentFromPages,
  getAllStickyHideEntries,
  getOrCreateQuietRevalidateState,
  hasConfirmedAuthorityForItem,
  hasPendingTaskPageGitHubOpsForItem,
  notifyTaskPageGitHubMutationRegistry,
  parseTaskPageGitHubItemKey,
  resolveItemSourceScope,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-registry'
import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'

export { adoptQuietSearchFieldsForItem, LAG_BACKOFF_MS, LAG_WALL_BUDGET_MS, MAX_LAG_TRAILS }

export type TaskPageQuietRevalidateScope = { queryKey: string; generation: number }

export function advanceTaskPageQuietRevalidateScope(
  scope: TaskPageQuietRevalidateScope,
  queryKey: string
): TaskPageQuietRevalidateScope {
  return scope.queryKey === queryKey ? scope : { queryKey, generation: scope.generation + 1 }
}

export function isTaskPageQuietRevalidateScopeCurrent(
  scope: TaskPageQuietRevalidateScope,
  queryKey: string,
  generation: number
): boolean {
  return scope.queryKey === queryKey && scope.generation === generation
}

export function isTaskPageQuietRevalidateRunCurrent(
  scope: TaskPageQuietRevalidateScope,
  queryKey: string,
  generation: number,
  capturedRefreshEpoch: number,
  currentRefreshEpoch: number
): boolean {
  return (
    isTaskPageQuietRevalidateScopeCurrent(scope, queryKey, generation) &&
    capturedRefreshEpoch === currentRefreshEpoch
  )
}

export function getTaskPageQuietRevalidateBackoffAttempt(attempts: Iterable<number>): number {
  const eligible = [...attempts].filter((attempt) => attempt < MAX_LAG_TRAILS)
  return eligible.length === 0 ? 0 : Math.max(...eligible)
}

export function settleQuietSearchRevalidate(args: {
  queryKey: string
  networkItems: readonly GitHubWorkItem[]
  fetchStartedAtGeneration: number
  patchWorkItem: TaskPageGitHubPatchWorkItem
  resolveSourceScope?: (item: GitHubWorkItem) => string | null
  sourceContextByRepoId?: ReadonlyMap<string, TaskSourceContext | null | undefined>
  revalidatedItemKeys?: ReadonlySet<string>
}): { needTrailing: boolean } {
  let needTrailing = false
  for (const serverItem of args.networkItems) {
    const sourceScope =
      args.resolveSourceScope?.(serverItem) ??
      resolveItemSourceScope(serverItem.repoId, serverItem.id, serverItem.repoExecutionHostId)
    const result = adoptQuietSearchFieldsForItem({
      item: serverItem,
      serverItem,
      sourceScope,
      queryKey: args.queryKey,
      fetchStartedAtGeneration: args.fetchStartedAtGeneration,
      patchWorkItem: args.patchWorkItem,
      sourceContext: args.sourceContextByRepoId?.get(serverItem.repoId)
    })
    if (result.needTrailing) {
      needTrailing = true
    }
  }
  // Why: do not GC sticky solely because search omitted a row under lag — that
  // would unhide a successful close under Open. Keep sticky for omitted rows
  // that still have pending or confirmed authority.
  const pageKeys = new Set(
    args.networkItems.map((item) =>
      taskPageGitHubItemKey(item.repoId, item.id, item.repoExecutionHostId)
    )
  )
  for (const [itemKey, entry] of getAllStickyHideEntries()) {
    if (
      entry.queryKey !== args.queryKey ||
      pageKeys.has(itemKey) ||
      !args.revalidatedItemKeys?.has(itemKey)
    ) {
      continue
    }
    const identity = parseTaskPageGitHubItemKey(itemKey)
    if (
      identity &&
      !hasPendingTaskPageGitHubOpsForItem(
        identity.repoId,
        identity.itemId,
        identity.repoExecutionHostId
      )
    ) {
      clearConfirmedAuthorityForItem(identity.repoId, identity.itemId, identity.repoExecutionHostId)
    }
  }
  const safeGcKeys = new Set(pageKeys)
  for (const [itemKey] of getAllStickyHideEntries()) {
    if (pageKeys.has(itemKey)) {
      continue
    }
    const identity = parseTaskPageGitHubItemKey(itemKey)
    if (!identity) {
      continue
    }
    if (
      hasPendingTaskPageGitHubOpsForItem(
        identity.repoId,
        identity.itemId,
        identity.repoExecutionHostId
      ) ||
      hasConfirmedAuthorityForItem(identity.repoId, identity.itemId, identity.repoExecutionHostId)
    ) {
      safeGcKeys.add(itemKey)
    }
  }
  gcStickyHidesAbsentFromPages(safeGcKeys, args.queryKey)
  const quiet = getOrCreateQuietRevalidateState(args.queryKey)
  // Why: lag counters are aggregated with Math.max across the query, so an orphan
  // stuck at MAX (item lagged then left the result set) would disable lag-retry
  // for every row. Drop counters for items fully gone (no page/pending/authority).
  for (const lagKey of quiet.lagSkipAttempts.keys()) {
    const itemKey = lagKey.slice(0, lagKey.lastIndexOf('\0'))
    if (safeGcKeys.has(itemKey)) {
      continue
    }
    const identity = parseTaskPageGitHubItemKey(itemKey)
    if (!identity) {
      continue
    }
    if (
      !hasPendingTaskPageGitHubOpsForItem(
        identity.repoId,
        identity.itemId,
        identity.repoExecutionHostId
      ) &&
      !hasConfirmedAuthorityForItem(identity.repoId, identity.itemId, identity.repoExecutionHostId)
    ) {
      quiet.lagSkipAttempts.delete(lagKey)
    }
  }
  if (quiet.dirtyGeneration > args.fetchStartedAtGeneration) {
    needTrailing = true
  }
  notifyTaskPageGitHubMutationRegistry()
  return { needTrailing }
}
export function processTaskPageQuietRevalidateSettle(args: {
  queryKey: string
  networkItems: readonly GitHubWorkItem[]
  patchWorkItem: TaskPageGitHubPatchWorkItem
  resolveSourceScope?: (item: GitHubWorkItem) => string | null
  sourceContextByRepoId?: ReadonlyMap<string, TaskSourceContext | null | undefined>
  revalidatedItemKeys?: ReadonlySet<string>
}): { needTrailing: boolean } {
  const state = getOrCreateQuietRevalidateState(args.queryKey)
  return settleQuietSearchRevalidate({
    queryKey: args.queryKey,
    networkItems: args.networkItems,
    fetchStartedAtGeneration: state.fetchStartedAtGeneration,
    patchWorkItem: args.patchWorkItem,
    resolveSourceScope: args.resolveSourceScope,
    sourceContextByRepoId: args.sourceContextByRepoId,
    revalidatedItemKeys: args.revalidatedItemKeys
  })
}
