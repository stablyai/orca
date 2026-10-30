import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import {
  adoptQuietSearchFieldsForItem,
  MAX_LAG_TRAILS
} from './task-page-github-work-item-quiet-adopt'
import {
  clearConfirmedAuthorityForItem,
  gcStickyHidesAbsentFromPages,
  getAllStickyHideEntries,
  hasConfirmedAuthorityForItem,
  hasPendingTaskPageGitHubOpsForItem,
  notifyTaskPageGitHubMutationRegistry,
  resolveItemSourceScope
} from './task-page-github-work-item-mutation-registry'
import { getOrCreateQuietRevalidateState } from './task-page-github-work-item-quiet-state'
import { taskPageGitHubItemKey } from './task-page-github-work-item-mutation-keys'
import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'

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
      resolveItemSourceScope(serverItem.repoId, serverItem.id)
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
  // Retain sticky hides for search-omitted rows with pending/confirmed authority so lag cannot unhide a successful membership exit.
  const pageKeys = new Set(
    args.networkItems.map((item) => taskPageGitHubItemKey(item.repoId, item.id))
  )
  for (const [itemKey, entry] of getAllStickyHideEntries()) {
    if (
      entry.queryKey !== args.queryKey ||
      pageKeys.has(itemKey) ||
      !args.revalidatedItemKeys?.has(itemKey)
    ) {
      continue
    }
    const separator = itemKey.indexOf('\0')
    if (
      separator !== -1 &&
      !hasPendingTaskPageGitHubOpsForItem(itemKey.slice(0, separator), itemKey.slice(separator + 1))
    ) {
      clearConfirmedAuthorityForItem(itemKey.slice(0, separator), itemKey.slice(separator + 1))
    }
  }
  const safeGcKeys = new Set(pageKeys)
  for (const [itemKey] of getAllStickyHideEntries()) {
    if (pageKeys.has(itemKey)) {
      continue
    }
    const sep = itemKey.indexOf('\0')
    if (sep === -1) {
      continue
    }
    const repoId = itemKey.slice(0, sep)
    const itemId = itemKey.slice(sep + 1)
    if (
      hasPendingTaskPageGitHubOpsForItem(repoId, itemId) ||
      hasConfirmedAuthorityForItem(repoId, itemId)
    ) {
      safeGcKeys.add(itemKey)
    }
  }
  gcStickyHidesAbsentFromPages(safeGcKeys, args.queryKey)
  const quiet = getOrCreateQuietRevalidateState(args.queryKey)
  // Drop orphan lag counters once page/pending/authority references are gone so unrelated rows retain their retry budget.
  for (const lagKey of quiet.lagSkipAttempts.keys()) {
    const itemKey = lagKey.slice(0, lagKey.lastIndexOf('\0'))
    if (safeGcKeys.has(itemKey)) {
      continue
    }
    const sep = itemKey.indexOf('\0')
    if (sep === -1) {
      continue
    }
    if (
      !hasPendingTaskPageGitHubOpsForItem(itemKey.slice(0, sep), itemKey.slice(sep + 1)) &&
      !hasConfirmedAuthorityForItem(itemKey.slice(0, sep), itemKey.slice(sep + 1))
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
